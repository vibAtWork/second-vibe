import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Where does SunJCE's per-message time go? AES-128-GCM, ns per message:
 *   same key     init(sameKey, iv) + doFinal       what the "Java" row does (key schedule cached)
 *   key changes  alternate between two keys        forces AES key expansion on every init
 *   init only    init(sameKey, iv), no doFinal     fixed cost of Cipher.init
 * and finally the heap bytes allocated per message.
 * Run: java JavaAblate.java [seconds]
 */
public class JavaAblate {
    static volatile long sink;

    public static void main(String[] a) throws Exception {
        double secs = a.length > 0 ? Double.parseDouble(a[0]) : 1.0;
        int[] sizes = {0, 16, 64, 1024, 16384};
        String[] modes = {"same key", "key changes", "init only"};
        System.out.printf("%-28s", "ns per message");
        for (int s : sizes) System.out.printf("%9dB", s);
        System.out.println();
        for (String m : modes) {
            for (int s : sizes) bench(m, s, Math.max(0.5, secs));   // warm up everything first
        }
        for (String m : modes) {
            System.out.printf("%-28s", m);
            for (int s : sizes) {
                if (m.equals("init only") && s > 0) { System.out.printf("%10s", "-"); continue; }
                System.out.printf("%10.0f", bench(m, s, secs));
            }
            System.out.println();
        }
        // heap allocation per message (same key, 64 B), via the JDK's per-thread allocation counter
        var mx = (com.sun.management.ThreadMXBean) java.lang.management.ManagementFactory.getThreadMXBean();
        long tid = Thread.currentThread().threadId();
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        SecretKeySpec key = new SecretKeySpec(new byte[16], "AES");
        byte[] in = new byte[64], out = new byte[80], iv = new byte[12];
        int n = 200_000;
        for (int pass = 0; pass < 2; pass++) {
            long before = mx.getThreadAllocatedBytes(tid);
            for (int i = 0; i < n; i++) {
                iv[0] = (byte) i; iv[1] = (byte) (i >> 8); iv[2] = (byte) (i >> 16); iv[3] = (byte) pass;
                c.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
                sink += c.doFinal(in, 0, 64, out, 0);
            }
            if (pass == 1)
                System.out.printf("heap allocated per message (64 B, same key): %d bytes%n",
                        (mx.getThreadAllocatedBytes(tid) - before) / n);
        }
    }

    static double bench(String mode, int size, double secs) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        byte[] k1 = new byte[16], k2 = new byte[16];
        k2[0] = 1;
        SecretKeySpec key1 = new SecretKeySpec(k1, "AES"), key2 = new SecretKeySpec(k2, "AES");
        byte[] in = new byte[size], out = new byte[size + 16], iv = new byte[12];
        long ops = 0, ctr = 0, t0 = System.nanoTime(), end = t0 + (long) (secs * 1e9), t;
        do {
            for (int b = 0; b < 1000; b++) {
                ctr++;
                for (int j = 0; j < 8; j++) iv[4 + j] = (byte) (ctr >>> (8 * j));
                SecretKeySpec k = mode.equals("key changes") && (ctr & 1) == 0 ? key2 : key1;
                c.init(Cipher.ENCRYPT_MODE, k, new GCMParameterSpec(128, iv));
                if (!mode.equals("init only")) sink += c.doFinal(in, 0, size, out, 0);
            }
            ops += 1000;
        } while ((t = System.nanoTime()) < end);
        return (double) (t - t0) / ops;
    }
}
