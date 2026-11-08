package tablescrub;

import tablescrub.web.Server;

/** Entry point. Configuration via environment variables, see README. */
public final class App {
    public static void main(String[] args) {
        int port = Integer.parseInt(env("PORT", "7070"));
        String host = env("HOST", "127.0.0.1");
        Server.Config cfg = new Server.Config(
                Integer.parseInt(env("TABLESCRUB_MAX_UPLOAD_MB", "100")),
                Integer.parseInt(env("TABLESCRUB_TTL_MINUTES", "60")),
                Integer.parseInt(env("TABLESCRUB_MAX_UPLOADS", "50")),
                Integer.parseInt(env("TABLESCRUB_MAX_ROWS", "1000000")));
        Server.create(cfg).start(host, port);
        System.out.println("tablescrub running on http://" + host + ":" + port);
    }

    private static String env(String k, String d) {
        String v = System.getenv(k);
        return v == null || v.isBlank() ? d : v;
    }
}
