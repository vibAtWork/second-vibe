package ff1;

import java.math.BigInteger;
import java.security.GeneralSecurityException;
import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;

/**
 * NIST SP 800-38G FF1 format-preserving encryption with AES (JCE).
 *
 * <p>Structure follows BouncyCastle's {@code SP80038G.encFF1/decFF1} (P block,
 * Q block, CBC-MAC PRF, S-block expansion, modular add/sub, word-grouped radix
 * conversion) with the same three optimizations used by every port in this
 * repository:
 * <ol>
 *   <li>CIPH_K(P) is computed once per call; each round CBC-MACs only Q.</li>
 *   <li>Feistel halves stay {@link BigInteger}s across rounds, so NUM/STR run
 *       once on entry and once on exit.</li>
 *   <li>radix^u and radix^v are computed once per call.</li>
 * </ol>
 * Instances are not thread-safe (the underlying {@link Cipher} is stateful).
 */
public final class FF1 {
    private static final int BLOCK = 16;
    private static final long MIN_DOMAIN = 1_000_000L;

    private final Cipher aes;
    private final int radix;
    private final BigInteger bigRadix;
    private final int groupLen;
    private final BigInteger groupPow;

    public FF1(byte[] key, int radix) {
        if (radix < 2 || radix > 65536) {
            throw new IllegalArgumentException("radix must be in [2, 65536]");
        }
        if (key.length != 16 && key.length != 24 && key.length != 32) {
            throw new IllegalArgumentException("key must be 16, 24 or 32 bytes");
        }
        try {
            aes = Cipher.getInstance("AES/ECB/NoPadding");
            aes.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
        this.radix = radix;
        this.bigRadix = BigInteger.valueOf(radix);
        int g = 0;
        long p = 1;
        while (p <= Long.MAX_VALUE / radix) {
            p *= radix;
            g++;
        }
        this.groupLen = g;
        this.groupPow = BigInteger.valueOf(p);
    }

    public int[] encrypt(byte[] tweak, int[] x) {
        return crypt(tweak, x, true);
    }

    public int[] decrypt(byte[] tweak, int[] x) {
        return crypt(tweak, x, false);
    }

    private void aesBlock(byte[] in, int inOff, byte[] out, int outOff) {
        try {
            aes.update(in, inOff, BLOCK, out, outOff);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException(e);
        }
    }

    static boolean lengthOk(int radix, int n) {
        if (n < 2) {
            return false;
        }
        long p = 1;
        for (int i = 0; i < n; i++) {
            p *= radix;
            if (p >= MIN_DOMAIN) {
                return true;
            }
        }
        return false;
    }

    /** b = ceil(ceil(v*log2(radix))/8), exact (BouncyCastle calculateB_FF1). */
    static int calcB(int radix, int v) {
        int tz = Integer.numberOfTrailingZeros(radix);
        int bits = tz * v;
        int odd = radix >>> tz;
        if (odd != 1) {
            bits += BigInteger.valueOf(odd).pow(v).bitLength();
        }
        return (bits + 7) / 8;
    }

    private int[] crypt(byte[] T, int[] x, boolean enc) {
        int n = x.length;
        if (!lengthOk(radix, n)) {
            throw new IllegalArgumentException("input length out of range (radix^n must be >= 1000000)");
        }
        for (int dgt : x) {
            if (dgt < 0 || dgt >= radix) {
                throw new IllegalArgumentException("digit out of range for radix");
            }
        }
        int t = T.length;
        int u = n / 2;
        int v = n - u;
        int b = calcB(radix, v);
        int d = (b + 7) & ~3;

        byte[] P = {1, 2, 1, (byte) (radix >> 16), (byte) (radix >> 8), (byte) radix, 10, (byte) u,
            (byte) (n >> 24), (byte) (n >> 16), (byte) (n >> 8), (byte) n,
            (byte) (t >> 24), (byte) (t >> 16), (byte) (t >> 8), (byte) t};
        byte[] encP = new byte[BLOCK];
        aesBlock(P, 0, encP, 0);

        int zeros = -(t + b + 1) & 15;
        byte[] Q = new byte[t + zeros + 1 + b];
        System.arraycopy(T, 0, Q, 0, t);
        int roundIdx = t + zeros;
        int numOff = roundIdx + 1;

        int nBlocks = (d + BLOCK - 1) / BLOCK;
        byte[] S = new byte[nBlocks * BLOCK];
        byte[] R = new byte[BLOCK];

        BigInteger modU = bigRadix.pow(u);
        BigInteger modV = v != u ? modU.multiply(bigRadix) : modU;

        BigInteger A = num(x, 0, u);
        BigInteger B = num(x, u, n);

        for (int k = 0; k < 10; k++) {
            int i = enc ? k : 9 - k;
            BigInteger src = enc ? B : A;

            // Q = T || 0^zeros || [i] || [NUM(src)]^b
            Q[roundIdx] = (byte) i;
            byte[] bs = src.toByteArray(); // may carry one leading 0x00 sign byte
            int copy = Math.min(bs.length, b);
            java.util.Arrays.fill(Q, numOff, Q.length - copy, (byte) 0);
            System.arraycopy(bs, bs.length - copy, Q, Q.length - copy, copy);

            // R = CBC-MAC(Q) chained from CIPH(P)
            System.arraycopy(encP, 0, R, 0, BLOCK);
            for (int off = 0; off < Q.length; off += BLOCK) {
                for (int j = 0; j < BLOCK; j++) {
                    R[j] ^= Q[off + j];
                }
                aesBlock(R, 0, R, 0);
            }
            // S = R || CIPH(R ^ [1]) || CIPH(R ^ [2]) ...
            System.arraycopy(R, 0, S, 0, BLOCK);
            int j0 = ((R[12] & 0xff) << 24) | ((R[13] & 0xff) << 16) | ((R[14] & 0xff) << 8) | (R[15] & 0xff);
            for (int j = 1; j < nBlocks; j++) {
                int off = j * BLOCK;
                System.arraycopy(R, 0, S, off, 12);
                int w = j0 ^ j;
                S[off + 12] = (byte) (w >>> 24);
                S[off + 13] = (byte) (w >>> 16);
                S[off + 14] = (byte) (w >>> 8);
                S[off + 15] = (byte) w;
                aesBlock(S, off, S, off);
            }
            BigInteger y = new BigInteger(1, S, 0, d);
            BigInteger mod = (i & 1) == 0 ? modU : modV;
            if (enc) {
                BigInteger c = A.add(y).mod(mod);
                A = B;
                B = c;
            } else {
                BigInteger c = B.subtract(y).mod(mod);
                B = A;
                A = c;
            }
        }
        int[] out = new int[n];
        str(A, out, 0, u);
        str(B, out, u, n);
        return out;
    }

    /** NUM_radix(x[from..to)) in long-sized digit groups (BouncyCastle RadixConverter idea). */
    private BigInteger num(int[] x, int from, int to) {
        BigInteger res = BigInteger.ZERO;
        for (int i = from; i < to; ) {
            int end = Math.min(i + groupLen, to);
            long acc = 0;
            long p = 1;
            for (; i < end; i++) {
                acc = acc * radix + x[i];
                p *= radix;
            }
            res = res.multiply(BigInteger.valueOf(p)).add(BigInteger.valueOf(acc));
        }
        return res;
    }

    /** STR_radix into out[from..to), most significant digit first. */
    private void str(BigInteger v, int[] out, int from, int to) {
        int i = to;
        while (i > from) {
            BigInteger[] qr = v.divideAndRemainder(groupPow);
            v = qr[0];
            long w = qr[1].longValue();
            for (int k = 0; k < groupLen && i > from; k++) {
                out[--i] = (int) (w % radix);
                w /= radix;
            }
        }
    }
}
