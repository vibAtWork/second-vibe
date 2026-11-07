package ff1;

import java.util.Arrays;
import org.bouncycastle.crypto.fpe.FPEFF1Engine;
import org.bouncycastle.crypto.params.FPEParameters;
import org.bouncycastle.crypto.params.KeyParameter;

/**
 * Cross-language FF1 benchmark protocol (see ../bench/PROTOCOL.md).
 *
 * <pre>java -cp target/ff1-0.1.0.jar:target/lib/* ff1.Bench &lt;ours|bc&gt; radix n keybits tweaklen</pre>
 */
public final class Bench {
    static final String ALPHA = "0123456789abcdefghijklmnopqrstuvwxyz";
    static volatile Object sink;

    static double env(String name, double def) {
        String s = System.getenv(name);
        return s == null ? def : Double.parseDouble(s);
    }

    static double measure(Runnable f) {
        double warm = env("FF1_WARMUP", 1.0);
        double sample = env("FF1_SAMPLE", 0.25);
        int nSamples = (int) env("FF1_SAMPLES", 7);
        long t0 = System.nanoTime();
        long count = 0;
        while (System.nanoTime() - t0 < (long) (warm * 1e9)) {
            f.run();
            count++;
        }
        long per = Math.max(1, (long) (count * sample / warm));
        double[] res = new double[nSamples];
        for (int s = 0; s < nSamples; s++) {
            long a = System.nanoTime();
            for (long i = 0; i < per; i++) f.run();
            res[s] = (double) (System.nanoTime() - a) / per;
        }
        Arrays.sort(res);
        return res[nSamples / 2];
    }

    public static void main(String[] args) {
        if (args.length != 5) {
            System.err.println("usage: Bench <ours|bc> radix n keybits tweaklen");
            System.exit(2);
        }
        int radix = Integer.parseInt(args[1]);
        int n = Integer.parseInt(args[2]);
        int keybits = Integer.parseInt(args[3]);
        int tlen = Integer.parseInt(args[4]);
        byte[] key = new byte[keybits / 8];
        for (int i = 0; i < key.length; i++) key[i] = (byte) i;
        byte[] tweak = new byte[tlen];
        for (int i = 0; i < tlen; i++) tweak[i] = (byte) i;
        int[] pt = new int[n];
        for (int i = 0; i < n; i++) pt[i] = (i * 7 + 3) % radix;

        String name;
        String ctStr;
        double e;
        double d;
        if (args[0].equals("ours")) {
            name = "java";
            FF1 c = new FF1(key, radix);
            int[] ct = c.encrypt(tweak, pt);
            if (!Arrays.equals(pt, c.decrypt(tweak, ct))) throw new AssertionError("round trip failed");
            ctStr = digits(ct);
            int[][] x = {pt};
            e = measure(() -> x[0] = c.encrypt(tweak, x[0]));
            int[][] y = {ct};
            d = measure(() -> y[0] = c.decrypt(tweak, y[0]));
            sink = x[0][0] + y[0][0];
        } else if (args[0].equals("bc")) {
            // BouncyCastle FPEFF1Engine with its default AES engine; digits as bytes (radix <= 256).
            name = "java-bouncycastle";
            FPEParameters params = new FPEParameters(new KeyParameter(key), radix, tweak);
            FPEFF1Engine encE = new FPEFF1Engine();
            encE.init(true, params);
            FPEFF1Engine decE = new FPEFF1Engine();
            decE.init(false, params);
            byte[] ptb = new byte[n];
            for (int i = 0; i < n; i++) ptb[i] = (byte) pt[i];
            byte[] ct = new byte[n];
            encE.processBlock(ptb, 0, n, ct, 0);
            byte[] back = new byte[n];
            decE.processBlock(ct, 0, n, back, 0);
            if (!Arrays.equals(ptb, back)) throw new AssertionError("round trip failed");
            int[] cti = new int[n];
            for (int i = 0; i < n; i++) cti[i] = ct[i] & 0xff;
            ctStr = digits(cti);
            byte[] x = ptb.clone();
            e = measure(() -> encE.processBlock(x, 0, n, x, 0));
            byte[] y = ct.clone();
            d = measure(() -> decE.processBlock(y, 0, n, y, 0));
            sink = x[0] + y[0];
        } else {
            throw new IllegalArgumentException("unknown impl " + args[0]);
        }
        System.out.printf("%s,%d,%d,%d,%d,encrypt,%.1f,%s%n", name, radix, n, keybits, tlen, e, ctStr);
        System.out.printf("%s,%d,%d,%d,%d,decrypt,%.1f,%s%n", name, radix, n, keybits, tlen, d, ctStr);
    }

    static String digits(int[] x) {
        StringBuilder sb = new StringBuilder();
        for (int v : x) sb.append(ALPHA.charAt(v));
        return sb.toString();
    }
}
