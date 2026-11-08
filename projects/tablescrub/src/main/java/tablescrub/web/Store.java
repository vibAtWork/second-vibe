package tablescrub.web;

import tablescrub.model.Table;

import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * In-memory upload store. Nothing is written to disk; uploads expire after a idle TTL and
 * can be discarded explicitly. IDs are 128-bit random so they are unguessable.
 */
public final class Store implements AutoCloseable {
    private static final SecureRandom RNG = new SecureRandom();

    public static final class Upload {
        public final String id;
        public final String filename;
        public final List<Table> tables;
        /** Random per-upload HMAC key, used for HASH unless the user supplies their own. */
        public final byte[] secret;
        public final Instant created = Instant.now();
        volatile Instant lastAccess = Instant.now();

        Upload(String id, String filename, List<Table> tables, byte[] secret) {
            this.id = id;
            this.filename = filename;
            this.tables = tables;
            this.secret = secret;
        }
    }

    private final Map<String, Upload> uploads = new ConcurrentHashMap<>();
    private final Duration ttl;
    private final int maxUploads;
    private final ScheduledExecutorService sweeper = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "store-sweeper");
        t.setDaemon(true);
        return t;
    });

    public Store(Duration ttl, int maxUploads) {
        this.ttl = ttl;
        this.maxUploads = maxUploads;
        sweeper.scheduleAtFixedRate(this::sweep, 1, 1, TimeUnit.MINUTES);
    }

    public Upload put(String filename, List<Table> tables) {
        while (uploads.size() >= maxUploads) {
            uploads.values().stream().min(Comparator.comparing(u -> u.lastAccess))
                    .ifPresent(u -> uploads.remove(u.id));
        }
        byte[] id = new byte[16];
        RNG.nextBytes(id);
        byte[] secret = new byte[32];
        RNG.nextBytes(secret);
        Upload u = new Upload(java.util.HexFormat.of().formatHex(id), filename, tables, secret);
        uploads.put(u.id, u);
        return u;
    }

    public Optional<Upload> get(String id) {
        Upload u = uploads.get(id);
        if (u != null) u.lastAccess = Instant.now();
        return Optional.ofNullable(u);
    }

    public void remove(String id) { uploads.remove(id); }

    public int size() { return uploads.size(); }

    public Duration ttl() { return ttl; }

    void sweep() {
        Instant cutoff = Instant.now().minus(ttl);
        uploads.values().removeIf(u -> u.lastAccess.isBefore(cutoff));
    }

    @Override
    public void close() { sweeper.shutdownNow(); }
}
