package tablescrub;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/** Tiny HTTP probe for the container HEALTHCHECK, so the runtime image needs no curl/wget. */
public final class HealthCheck {
    public static void main(String[] args) {
        String port = System.getenv().getOrDefault("PORT", "7070");
        try {
            HttpResponse<String> r = HttpClient.newHttpClient().send(
                    HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/healthz"))
                            .timeout(Duration.ofSeconds(2)).build(),
                    HttpResponse.BodyHandlers.ofString());
            System.exit(r.statusCode() == 200 ? 0 : 1);
        } catch (Exception e) {
            System.exit(1);
        }
    }
}
