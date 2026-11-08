package tablescrub;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.javalin.Javalin;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import tablescrub.web.Server;

import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

class ServerTest {
    static Javalin app;
    static String base;
    static final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build();

    @BeforeAll
    static void start() {
        app = Server.create(Server.Config.defaults()).start("127.0.0.1", 0);
        base = "http://127.0.0.1:" + app.port();
    }

    @AfterAll
    static void stop() { app.stop(); }

    static HttpResponse<String> multipart(String path, Map<String, String> fields, String filename, byte[] file, boolean htmx)
            throws Exception {
        String boundary = "----b" + UUID.randomUUID();
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (var e : fields.entrySet()) {
            body.writeBytes(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + e.getKey() + "\"\r\n\r\n"
                    + e.getValue() + "\r\n").getBytes(StandardCharsets.UTF_8));
        }
        body.writeBytes(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + filename
                + "\"\r\nContent-Type: application/octet-stream\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        body.writeBytes(file);
        body.writeBytes(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(base + path))
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .POST(HttpRequest.BodyPublishers.ofByteArray(body.toByteArray()));
        if (htmx) b.header("HX-Request", "true");
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    static HttpResponse<String> form(String path, Map<String, String> fields) throws Exception {
        String body = fields.entrySet().stream()
                .map(e -> URLEncoder.encode(e.getKey(), StandardCharsets.UTF_8) + "=" + URLEncoder.encode(e.getValue(), StandardCharsets.UTF_8))
                .collect(Collectors.joining("&"));
        return http.send(HttpRequest.newBuilder(URI.create(base + path))
                .header("Content-Type", "application/x-www-form-urlencoded").header("HX-Request", "true")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
    }

    static HttpResponse<String> get(String path) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create(base + path)).build(), HttpResponse.BodyHandlers.ofString());
    }

    static byte[] cohort() throws Exception { return Files.readAllBytes(Path.of("samples/cohort.csv")); }

    @Test
    void homeAndAssets() throws Exception {
        assertEquals(200, get("/").statusCode());
        assertTrue(get("/").headers().firstValue("Content-Security-Policy").isPresent());
        assertEquals(200, get("/webjars/htmx.org/2.0.8/dist/htmx.min.js").statusCode());
        var css = get("/static/app.css");
        assertEquals(200, css.statusCode());
        assertTrue(css.headers().firstValue("Content-Type").orElse("").startsWith("text/css"));
    }

    @Test
    void uploadPreviewExportDiscard() throws Exception {
        var up = multipart("/upload", Map.of(), "cohort.csv", cohort(), true);
        assertEquals(200, up.statusCode());
        String push = up.headers().firstValue("HX-Push-Url").orElseThrow();
        assertTrue(push.startsWith("/d/"));
        String id = push.substring(3);
        assertTrue(up.body().contains("id=\"workspace\""));
        assertTrue(up.body().contains("national id"));
        // suggested treatment is pre-selected: first_name (column 1) -> DROP
        assertTrue(up.body().matches("(?s).*name=\"a1\".*?value=\"DROP\"[^>]*selected.*"), "DROP pre-selected for first_name");

        Map<String, String> plan = new LinkedHashMap<>();
        plan.put("a0", "PSEUDONYM");
        for (int i : new int[]{1, 2, 4}) plan.put("a" + i, "DROP");
        plan.put("a3", "HASH");
        plan.put("a5", "GENERALIZE"); plan.put("p5", "decade"); plan.put("q5", "on");
        plan.put("q6", "on");
        plan.put("a7", "GENERALIZE"); plan.put("p7", "1000"); plan.put("q7", "on");
        plan.put("a8", "DROP");
        plan.put("k", "5");
        plan.put("title", "Cohort extract");
        plan.put("d11", "Systolic blood pressure, mmHg");
        var prev = form("/d/" + id + "/t/0/preview", plan);
        assertEquals(200, prev.statusCode());
        assertTrue(prev.body().contains("id=\"preview\""));
        assertTrue(prev.body().contains("k = "));
        assertFalse(prev.body().contains("@example.org"), "emails must not appear in preview");

        plan.put("format", "md");
        var md = form("/d/" + id + "/t/0/export", plan);
        assertEquals(200, md.statusCode());
        assertTrue(md.headers().firstValue("Content-Disposition").orElse("").contains("cohort-extract-redacted.md"));
        assertTrue(md.body().contains("Systolic blood pressure, mmHg"));
        assertTrue(md.body().contains("ID-0001"));
        assertFalse(md.body().contains("@example.org"));
        assertFalse(md.body().matches("(?s).*\\d{6}-\\d{4}.*"), "no CPR numbers in export");

        assertEquals("/?discarded=1", form("/d/" + id + "/discard", Map.of()).headers().firstValue("HX-Redirect").orElse(""));
        assertEquals("/?expired=1", form("/d/" + id + "/t/0/preview", plan).headers().firstValue("HX-Redirect").orElse(""));
    }

    @Test
    void uploadErrorIsShownInline() throws Exception {
        var r = multipart("/upload", Map.of(), "bad.json", "{not json".getBytes(StandardCharsets.UTF_8), true);
        assertEquals(200, r.statusCode());
        assertTrue(r.body().contains("alert error"));
        assertTrue(r.body().contains("Invalid JSON"));
    }

    @Test
    void apiInspectAndRedact() throws Exception {
        var ins = multipart("/api/inspect", Map.of(), "cohort.csv", cohort(), false);
        assertEquals(200, ins.statusCode());
        JsonNode j = new ObjectMapper().readTree(ins.body());
        assertEquals(400, j.get("tables").get(0).get("rows").asInt());
        assertEquals("email", j.get("tables").get(0).get("columns").get(4).get("pii").get("category").asText());

        var auto = multipart("/api/redact", Map.of("format", "jsonl"), "cohort.csv", cohort(), false);
        assertEquals(200, auto.statusCode());
        assertFalse(auto.body().contains("@example.org"), "auto plan drops emails");
        assertEquals(400, auto.body().strip().split("\n").length);

        String plan = "{\"columns\":{\"email\":\"MASK\",\"zip\":{\"action\":\"GENERALIZE\",\"param\":\"1000\",\"qi\":true}},\"k\":3}";
        var custom = multipart("/api/redact", Map.of("format", "csv", "plan", plan), "cohort.csv", cohort(), false);
        assertEquals(200, custom.statusCode());
        assertTrue(custom.body().contains("[REDACTED]"));
        assertTrue(custom.body().contains("Anna"), "unlisted columns are kept without auto");

        var bad = multipart("/api/redact", Map.of("format", "pdf"), "cohort.csv", cohort(), false);
        assertEquals(400, bad.statusCode());
        assertTrue(bad.body().contains("unknown format"));
        assertEquals(200, get("/api/formats").statusCode());
    }
}
