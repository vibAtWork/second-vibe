package tablescrub.web;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import io.javalin.Javalin;
import io.javalin.http.Context;
import io.javalin.http.UploadedFile;
import io.javalin.http.staticfiles.Location;
import io.javalin.config.SizeUnit;
import tablescrub.export.Documentation;
import tablescrub.export.Format;
import tablescrub.io.Profiler;
import tablescrub.io.ReadOptions;
import tablescrub.io.Readers;
import tablescrub.model.Column;
import tablescrub.model.RawTable;
import tablescrub.model.Table;
import tablescrub.redact.Action;
import tablescrub.redact.ColumnRule;
import tablescrub.redact.Plan;
import tablescrub.redact.RedactedTable;
import tablescrub.redact.Redactor;
import tablescrub.web.Store.Upload;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** HTTP routes: htmx-driven UI plus a small JSON/multipart API for scripting. */
public final class Server {
    public record Config(int maxUploadMb, int ttlMinutes, int maxUploads, int maxRows) {
        public static Config defaults() { return new Config(100, 60, 50, 1_000_000); }
    }

    static final int PREVIEW_ROWS = 50;
    private static final ObjectMapper JSON = new ObjectMapper();

    private final Config cfg;
    private final Store store;
    private final Templates templates = new Templates();

    private Server(Config cfg) {
        this.cfg = cfg;
        this.store = new Store(Duration.ofMinutes(cfg.ttlMinutes()), cfg.maxUploads());
    }

    public static Javalin create(Config cfg) {
        return new Server(cfg).app();
    }

    private Javalin app() {
        Javalin app = Javalin.create(c -> {
            c.showJavalinBanner = false;
            c.staticFiles.enableWebjars();
            c.staticFiles.add(sf -> {
                sf.hostedPath = "/static";
                sf.directory = "/static";
                sf.location = Location.CLASSPATH;
            });
            c.http.maxRequestSize = (long) cfg.maxUploadMb() * 1024 * 1024;
            c.jetty.multipartConfig.maxFileSize(cfg.maxUploadMb(), SizeUnit.MB);
            c.jetty.multipartConfig.maxTotalRequestSize(cfg.maxUploadMb() + 1L, SizeUnit.MB);
            c.jetty.multipartConfig.maxInMemoryFileSize(cfg.maxUploadMb(), SizeUnit.MB);
        });
        app.before(ctx -> {
            ctx.header("X-Content-Type-Options", "nosniff");
            ctx.header("X-Frame-Options", "DENY");
            ctx.header("Referrer-Policy", "no-referrer");
            ctx.header("Content-Security-Policy",
                    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
            if (!ctx.path().startsWith("/static") && !ctx.path().startsWith("/webjars"))
                ctx.header("Cache-Control", "no-store");
        });
        app.events(e -> e.serverStopped(store::close));

        app.get("/healthz", ctx -> ctx.result("ok"));
        app.get("/", ctx -> {
            Map<String, Object> m = base();
            if (ctx.queryParam("discarded") != null) m.put("notice", "The upload was discarded from server memory.");
            if (ctx.queryParam("expired") != null) m.put("error", "That upload has expired or was discarded. Please upload the file again.");
            ctx.html(templates.page("index", m));
        });
        app.post("/upload", this::upload);
        app.get("/d/{id}", ctx -> withUpload(ctx, u -> {
            int t = tableIndex(ctx, u, ctx.queryParamAsClass("t", Integer.class).getOrDefault(0));
            Map<String, Object> m = base();
            m.putAll(workspace(u, t, PlanParser.suggested(u.tables.get(t)), null));
            ctx.html(templates.page("index", m));
        }));
        app.get("/d/{id}/t/{t}", ctx -> withUpload(ctx, u -> {
            int t = tableIndex(ctx, u, Integer.parseInt(ctx.pathParam("t")));
            Table table = u.tables.get(t);
            List<ColumnRule> rules = "keep".equals(ctx.queryParam("mode")) ? PlanParser.keepAll(table) : PlanParser.suggested(table);
            ctx.header("HX-Push-Url", "/d/" + u.id + "?t=" + t);
            ctx.html(templates.fragment("workspace", "workspace", workspace(u, t, rules, null)));
        }));
        app.post("/d/{id}/t/{t}/preview", ctx -> withUpload(ctx, u -> {
            int t = tableIndex(ctx, u, Integer.parseInt(ctx.pathParam("t")));
            Table table = u.tables.get(t);
            Plan plan = PlanParser.fromForm(ctx.formParamMap(), table, u.secret);
            ctx.html(templates.fragment("workspace", "preview", previewModel(u, t, table, plan)));
        }));
        app.post("/d/{id}/t/{t}/export", ctx -> withUpload(ctx, u -> {
            int t = tableIndex(ctx, u, Integer.parseInt(ctx.pathParam("t")));
            Table table = u.tables.get(t);
            Plan plan = PlanParser.fromForm(ctx.formParamMap(), table, u.secret);
            Format f = Format.byId(ctx.formParam("format")).orElse(Format.CSV);
            send(ctx, Redactor.apply(table, plan), f);
        }));
        app.post("/d/{id}/discard", ctx -> {
            store.remove(ctx.pathParam("id"));
            if (isHtmx(ctx)) ctx.header("HX-Redirect", "/?discarded=1");
            else ctx.redirect("/?discarded=1");
        });

        app.post("/api/inspect", this::apiInspect);
        app.post("/api/redact", this::apiRedact);
        app.get("/api/formats", ctx -> {
            ArrayNode arr = JSON.createArrayNode();
            for (Format f : Format.values())
                arr.addObject().put("id", f.id).put("label", f.label).put("extension", f.extension).put("description", f.help);
            ctx.json(arr);
        });

        app.exception(Exception.class, (e, ctx) -> {
            if (ctx.path().startsWith("/api/")) {
                ctx.status(400).json(Map.of("error", String.valueOf(e.getMessage())));
            } else {
                Map<String, Object> m = base();
                m.put("error", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
                try {
                    if (isHtmx(ctx)) ctx.status(200).html(templates.fragment("index", "alert", m));
                    else ctx.status(400).html(templates.page("index", m));
                } catch (RuntimeException renderFailure) {
                    org.slf4j.LoggerFactory.getLogger(Server.class).error("error page failed", renderFailure);
                    ctx.status(500).result("Internal error: " + m.get("error"));
                }
            }
        });
        return app;
    }

    // ---------- UI handlers ----------

    private void upload(Context ctx) throws IOException {
        UploadedFile file = ctx.uploadedFile("file");
        if (file == null || file.size() == 0) throw new IOException("Please choose a file to upload.");
        List<Table> tables = load(file);
        Upload u = store.put(file.filename(), tables);
        if (isHtmx(ctx)) {
            ctx.header("HX-Push-Url", "/d/" + u.id);
            ctx.html(templates.fragment("workspace", "workspace", workspace(u, 0, PlanParser.suggested(tables.getFirst()), null)));
        } else {
            ctx.redirect("/d/" + u.id);
        }
    }

    private List<Table> load(UploadedFile file) throws IOException {
        byte[] bytes;
        try (InputStream in = file.content()) { bytes = in.readAllBytes(); }
        List<RawTable> raws = Readers.read(file.filename(), bytes, new ReadOptions(cfg.maxRows(), 2_000));
        List<Table> tables = new ArrayList<>();
        for (RawTable r : raws) tables.add(Profiler.profile(r));
        return tables;
    }

    private Map<String, Object> workspace(Upload u, int t, List<ColumnRule> rules, Plan planOrNull) {
        Table table = u.tables.get(t);
        Plan plan = planOrNull != null ? planOrNull
                : new Plan(rules, u.secret, PlanParser.DEFAULT_K, false, "", "", "");
        Map<String, Object> m = previewModel(u, t, table, plan);
        List<ColView> cols = new ArrayList<>();
        for (Column c : table.columns()) cols.add(new ColView(c, plan.rule(c.index()), table.rowCount()));
        m.put("cols", cols);
        m.put("tables", u.tables);
        m.put("filename", u.filename);
        m.put("flagged", table.columns().stream().filter(c -> c.pii().flagged()).count());
        m.put("actions", Action.values());
        m.put("formats", Format.values());
        m.put("ttl", cfg.ttlMinutes());
        return m;
    }

    private Map<String, Object> previewModel(Upload u, int t, Table table, Plan plan) {
        Map<String, Object> m = new HashMap<>();
        m.put("u", u);
        m.put("id", u.id);
        m.put("t", t);
        m.put("table", table);
        m.put("plan", plan);
        RedactedTable preview = Redactor.apply(table, plan, PREVIEW_ROWS);
        m.put("preview", preview);
        m.put("previewRows", preview.rows().size());
        m.put("outRows", table.rowCount() - preview.kStats().rowsSuppressed());
        return m;
    }

    /** One row in the column editor. */
    public record ColView(Column c, ColumnRule r, int rowCount) {
        public String fill() {
            return rowCount == 0 ? "0%" : Math.round(100.0 * c.nonNull() / rowCount) + "%";
        }

        public String samples() {
            return String.join(" · ", c.samples().stream().map(s -> s.length() > 30 ? s.substring(0, 29) + "…" : s).toList());
        }

        public String paramHint() {
            return switch (r.action()) {
                case MASK -> "[REDACTED]";
                case HASH -> "16";
                case PSEUDONYM -> "ID-";
                case SUPPRESS_RARE -> "k = 5";
                case ROUND -> "decimals, e.g. 0 or -1";
                case GENERALIZE -> switch (c.type()) {
                    case DATE, DATETIME -> "year | month | decade";
                    case INTEGER, DECIMAL -> "bin width, e.g. 10";
                    default -> "chars to keep, e.g. 2";
                };
                default -> "";
            };
        }

        public boolean needsParam() {
            return switch (r.action()) {
                case KEEP, DROP -> false;
                default -> true;
            };
        }

        public String level() {
            return c.pii().level().name().toLowerCase(Locale.ROOT);
        }
    }

    // ---------- API ----------

    private void apiInspect(Context ctx) throws IOException {
        UploadedFile file = ctx.uploadedFile("file");
        if (file == null) throw new IOException("multipart field 'file' is required");
        List<Table> tables = load(file);
        ObjectNode root = JSON.createObjectNode();
        root.put("filename", file.filename());
        ArrayNode ts = root.putArray("tables");
        for (int i = 0; i < tables.size(); i++) {
            Table t = tables.get(i);
            ObjectNode tn = ts.addObject();
            tn.put("index", i).put("name", t.name()).put("format", t.sourceFormat()).put("rows", t.rowCount());
            ArrayNode w = tn.putArray("warnings");
            t.warnings().forEach(w::add);
            ArrayNode cs = tn.putArray("columns");
            for (Column c : t.columns()) {
                ObjectNode cn = cs.addObject();
                cn.put("name", c.name()).put("type", c.type().frictionless()).put("nonNull", c.nonNull())
                        .put("distinct", c.distinct()).put("unique", c.unique());
                if (c.pii().flagged()) {
                    cn.putObject("pii").put("category", c.pii().category()).put("level", c.pii().level().name())
                            .put("reason", c.pii().reason()).put("suggestion", c.pii().suggestion());
                }
            }
        }
        ctx.json(root);
    }

    private void apiRedact(Context ctx) throws IOException {
        UploadedFile file = ctx.uploadedFile("file");
        if (file == null) throw new IOException("multipart field 'file' is required");
        List<Table> tables = load(file);
        int idx = parseIntOr(ctx.formParam("sheet"), 0);
        if (idx < 0 || idx >= tables.size()) throw new IOException("sheet index out of range (0.." + (tables.size() - 1) + ")");
        Table table = tables.get(idx);
        String planJson = ctx.formParam("plan");
        JsonNode planNode = planJson == null || planJson.isBlank() ? JSON.createObjectNode().put("auto", true) : JSON.readTree(planJson);
        byte[] secret = new byte[32];
        new java.security.SecureRandom().nextBytes(secret);
        Plan plan = PlanParser.fromJson(planNode, table, secret);
        String fmt = ctx.formParam("format");
        Format f = Format.byId(fmt == null ? "csv" : fmt)
                .orElseThrow(() -> new IOException("unknown format '" + fmt + "'; see GET /api/formats"));
        send(ctx, Redactor.apply(table, plan), f);
    }

    // ---------- helpers ----------

    private void send(Context ctx, RedactedTable rt, Format f) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        f.write(rt, buf);
        String name = Documentation.slug(rt.name()) + "-redacted." + f.extension;
        ctx.contentType(f.mime);
        ctx.header("Content-Disposition", "attachment; filename=\"" + name + "\"");
        ctx.result(buf.toByteArray());
    }

    @FunctionalInterface
    private interface UploadHandler { void handle(Upload u) throws Exception; }

    private void withUpload(Context ctx, UploadHandler h) throws Exception {
        var u = store.get(ctx.pathParam("id"));
        if (u.isEmpty()) {
            if (isHtmx(ctx)) ctx.header("HX-Redirect", "/?expired=1");
            else ctx.redirect("/?expired=1");
            return;
        }
        h.handle(u.get());
    }

    private static int tableIndex(Context ctx, Upload u, int t) {
        return Math.max(0, Math.min(u.tables.size() - 1, t));
    }

    private static boolean isHtmx(Context ctx) {
        return "true".equals(ctx.header("HX-Request"));
    }

    private static int parseIntOr(String s, int d) {
        try { return s == null || s.isBlank() ? d : Integer.parseInt(s.strip()); } catch (NumberFormatException e) { return d; }
    }

    private Map<String, Object> base() {
        Map<String, Object> m = new HashMap<>();
        m.put("maxMb", cfg.maxUploadMb());
        m.put("ttl", cfg.ttlMinutes());
        m.put("supported", String.join(" ", Readers.SUPPORTED));
        m.put("accept", String.join(",", Readers.SUPPORTED));
        return m;
    }
}
