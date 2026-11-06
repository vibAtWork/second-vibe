import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import java.security.Provider;
import java.security.Security;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;

/**
 * AES-GCM throughput benchmark for the JCA (default: SunJCE).
 *
 * Methodology mirrors c/gcm_bench.c so the numbers are comparable:
 *   encrypt: per message -> init(key, fresh 12-byte IV) + doFinal (seal + 16-byte tag)
 *   decrypt: per message -> init(key, fixed IV)         + doFinal (open + tag verify)
 *
 * Output: CSV lines  impl,op,keybits,size,ops,seconds,MBps
 */
public class GcmBench {
    static double seconds = 1.0;
    static double warmupSeconds = 3.0;
    static int[] sizes = {16, 64, 256, 1024, 8192, 16384, 1 << 20};
    static int[] keyBits = {128, 256};
    static String providerName = null;
    static boolean selfTestOnly = false;
    static volatile long sink;

    public static void main(String[] args) throws Exception {
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--seconds" -> seconds = Double.parseDouble(args[++i]);
                case "--warmup" -> warmupSeconds = Double.parseDouble(args[++i]);
                case "--sizes" -> sizes = Arrays.stream(args[++i].split(",")).mapToInt(Integer::parseInt).toArray();
                case "--keys" -> keyBits = Arrays.stream(args[++i].split(",")).mapToInt(Integer::parseInt).toArray();
                case "--provider" -> providerName = args[++i];
                case "--self-test" -> selfTestOnly = true;
                default -> { System.err.println("unknown arg: " + args[i]); System.exit(2); }
            }
        }
        selfTest();
        if (selfTestOnly) { System.err.println("java self-test: OK"); return; }

        String impl = "java-" + newCipher().getProvider().getName();
        System.err.printf("# %s, Java %s (%s), warmup %.1fs%n", impl,
                System.getProperty("java.version"), System.getProperty("java.vm.name"), warmupSeconds);

        for (int kb : keyBits) {
            byte[] key = new byte[kb / 8];
            Arrays.fill(key, (byte) 0x42);
            SecretKeySpec k = new SecretKeySpec(key, "AES");
            // Warm up JIT (C2 + AES/GHASH intrinsics) across all sizes before measuring.
            long warmEnd = System.nanoTime() + (long) (warmupSeconds * 1e9);
            while (System.nanoTime() < warmEnd) {
                for (int sz : sizes) {
                    run(k, sz, "enc", Math.min(0.02, warmupSeconds / sizes.length));
                    run(k, sz, "dec", Math.min(0.02, warmupSeconds / sizes.length));
                }
            }
            for (String op : new String[]{"enc", "dec"}) {
                for (int sz : sizes) {
                    double[] r = run(k, sz, op, seconds);
                    System.out.printf("%s,%s,%d,%d,%d,%.6f,%.2f%n", impl, op, kb, sz, (long) r[0], r[1],
                            r[0] * sz / r[1] / 1e6);
                    System.out.flush();
                }
            }
        }
        System.err.println("# sink " + sink);
    }

    static Cipher newCipher() throws Exception {
        return providerName == null ? Cipher.getInstance("AES/GCM/NoPadding")
                : Cipher.getInstance("AES/GCM/NoPadding", providerName);
    }

    /** returns {ops, elapsedSeconds} */
    static double[] run(SecretKeySpec key, int size, String op, double secs) throws Exception {
        Cipher c = newCipher();
        byte[] in = new byte[size];
        byte[] out = new byte[size + 16];
        byte[] iv = new byte[12];
        for (int i = 0; i < size; i++) in[i] = (byte) i;
        byte[] ct = null;
        GCMParameterSpec fixed = new GCMParameterSpec(128, iv);
        if (op.equals("dec")) {
            c.init(Cipher.ENCRYPT_MODE, key, fixed);
            ct = c.doFinal(in);
        }
        long ops = 0, ctr = System.nanoTime();
        long start = System.nanoTime(), deadline = start + (long) (secs * 1e9), now;
        // batch ops between clock reads so timer overhead doesn't dominate tiny messages
        int batch = size >= 65536 ? 1 : size >= 4096 ? 16 : 256;
        do {
            for (int b = 0; b < batch; b++) {
                if (ct == null) {
                    // SunJCE refuses key+IV reuse for encryption, so use a counter IV (as you would in practice)
                    ctr++;
                    iv[4] = (byte) (ctr >>> 56); iv[5] = (byte) (ctr >>> 48); iv[6] = (byte) (ctr >>> 40);
                    iv[7] = (byte) (ctr >>> 32); iv[8] = (byte) (ctr >>> 24); iv[9] = (byte) (ctr >>> 16);
                    iv[10] = (byte) (ctr >>> 8); iv[11] = (byte) ctr;
                    c.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
                    sink += c.doFinal(in, 0, size, out, 0);
                } else {
                    c.init(Cipher.DECRYPT_MODE, key, fixed);
                    sink += c.doFinal(ct, 0, ct.length, out, 0);
                }
            }
            ops += batch;
            now = System.nanoTime();
        } while (now < deadline);
        return new double[]{ops, (now - start) / 1e9};
    }

    /** NIST GCM test vectors (gcmEncryptExtIV128/256, 60-byte PT + 20-byte AAD) — sanity check before timing. */
    static void selfTest() throws Exception {
        HexFormat h = HexFormat.of();
        String[][] v = {
            {"feffe9928665731c6d6a8f9467308308",
             "cafebabefacedbaddecaf888",
             "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
             "feedfacedeadbeeffeedfacedeadbeefabaddad2",
             "42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e0915bc94fbc3221a5db94fae95ae7121a47"},
            {"feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308",
             "cafebabefacedbaddecaf888",
             "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39",
             "feedfacedeadbeeffeedfacedeadbeefabaddad2",
             "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662" + "76fc6ece0f4e1768cddf8853bb2d551b"},
        };
        for (String[] t : v) {
            Cipher c = newCipher();
            SecretKeySpec k = new SecretKeySpec(h.parseHex(t[0]), "AES");
            c.init(Cipher.ENCRYPT_MODE, k, new GCMParameterSpec(128, h.parseHex(t[1])));
            c.updateAAD(h.parseHex(t[3]));
            byte[] got = c.doFinal(h.parseHex(t[2]));
            if (!h.formatHex(got).equals(t[4]))
                throw new IllegalStateException("self-test failed for key " + t[0] + ": " + h.formatHex(got));
            c.init(Cipher.DECRYPT_MODE, k, new GCMParameterSpec(128, h.parseHex(t[1])));
            c.updateAAD(h.parseHex(t[3]));
            if (!Arrays.equals(c.doFinal(got), h.parseHex(t[2])))
                throw new IllegalStateException("self-test decrypt failed");
        }
    }
}
