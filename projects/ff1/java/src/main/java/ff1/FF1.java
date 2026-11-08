package ff1;

import java.lang.invoke.MethodHandle;
import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import java.lang.invoke.VarHandle;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.math.BigInteger;
import java.nio.ByteOrder;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.spec.SecretKeySpec;

/**
 * NIST SP 800-38G FF1 format-preserving encryption with AES.
 *
 * <p>Structure follows BouncyCastle's {@code SP80038G.encFF1/decFF1}. Optimizations
 * (shared with the other ports in this repository):
 * <ol>
 *   <li>Per-(n, tweak length) values (b, d, CIPH_K(P), radix^u, radix^v) are cached.</li>
 *   <li>Q blocks made only of tweak/zero bytes are CBC-MACed once per call.</li>
 *   <li>Feistel halves stay numbers across rounds (NUM/STR only at entry/exit).</li>
 *   <li>Fast path when radix^v &lt; 2^96: halves are pairs of {@code long}s, the
 *       varying Q block is a 128-bit XOR, S = R, and reduction uses Möller–Granlund
 *       reciprocal division ({@link Math#unsignedMultiplyHigh}).</li>
 *   <li>Limb path up to 2^4096: fixed-width little-endian {@code long[]} limbs,
 *       Knuth algorithm D for y mod radix^m, scratch arrays reused across calls.
 *       {@link BigInteger} is only the fallback beyond that (and the test oracle).</li>
 *   <li>Digit extraction divides by the radix with a precomputed reciprocal.</li>
 * </ol>
 *
 * <p>AES backend: the JDK's AES-NI intrinsic ({@code com.sun.crypto.provider.AESCrypt})
 * when the JVM runs with {@code --add-opens java.base/com.sun.crypto.provider=ALL-UNNAMED},
 * which skips the JCE {@link Cipher} layers (measured 11.6 vs 25 ns per block);
 * otherwise standard JCE {@code AES/ECB/NoPadding}. Both give identical results.
 *
 * <p>Instances are not thread-safe (cached parameters and scratch state).
 */
public final class FF1 {
    private static final int BLOCK = 16;
    private static final long MIN_DOMAIN = 1_000_000L;
    private static final VarHandle LONG_BE =
        MethodHandles.byteArrayViewVarHandle(long[].class, ByteOrder.BIG_ENDIAN);
    private static final BigInteger TWO64 = BigInteger.ONE.shiftLeft(64);

    /** One AES block encryption, in place. */
    abstract static class Aes {
        abstract void encrypt(byte[] buf, int off);
    }

    static final class JceAes extends Aes {
        private final Cipher c;

        JceAes(byte[] key) {
            try {
                c = Cipher.getInstance("AES/ECB/NoPadding");
                c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"));
            } catch (GeneralSecurityException e) {
                throw new IllegalStateException(e);
            }
        }

        @Override
        void encrypt(byte[] buf, int off) {
            try {
                c.update(buf, off, BLOCK, buf, off);
            } catch (GeneralSecurityException e) {
                throw new IllegalStateException(e);
            }
        }
    }

    static final class IntrinsicAes extends Aes {
        private static final MethodHandle INIT;
        private static final MethodHandle ENC;
        private static final Constructor<?> CTOR;

        static {
            MethodHandle init = null;
            MethodHandle enc = null;
            Constructor<?> ctor = null;
            try {
                Class<?> k = Class.forName("com.sun.crypto.provider.AESCrypt");
                ctor = k.getDeclaredConstructor();
                ctor.setAccessible(true);
                Method mi = k.getDeclaredMethod("init", boolean.class, String.class, byte[].class);
                mi.setAccessible(true);
                Method me = k.getDeclaredMethod("encryptBlock", byte[].class, int.class, byte[].class, int.class);
                me.setAccessible(true);
                MethodHandles.Lookup l = MethodHandles.lookup();
                init = l.unreflect(mi).asType(
                    MethodType.methodType(void.class, Object.class, boolean.class, String.class, byte[].class));
                enc = l.unreflect(me).asType(
                    MethodType.methodType(void.class, Object.class, byte[].class, int.class, byte[].class, int.class));
            } catch (Throwable t) {
                init = null;
                enc = null;
                ctor = null;
            }
            INIT = init;
            ENC = enc;
            CTOR = ctor;
        }

        static boolean available() {
            return ENC != null;
        }

        private final Object aes;

        IntrinsicAes(byte[] key) {
            try {
                aes = CTOR.newInstance();
                INIT.invokeExact(aes, false, "AES", key);
            } catch (Throwable t) {
                throw new IllegalStateException(t);
            }
        }

        @Override
        void encrypt(byte[] buf, int off) {
            try {
                ENC.invokeExact(aes, buf, off, buf, off);
            } catch (Throwable t) {
                throw new IllegalStateException(t);
            }
        }
    }

    /** Reduction modulo an invariant modulus below 2^96 (Möller–Granlund). */
    static final class Recip {
        final long mHi;
        final long mLo;
        final boolean wide;
        final int s;
        final long d1;
        final long d0;
        final long v;

        Recip(BigInteger m) {
            mHi = m.shiftRight(64).longValue();
            mLo = m.longValue();
            wide = mHi != 0;
            if (!wide) {
                s = Long.numberOfLeadingZeros(mLo);
                d1 = 0;
                d0 = mLo << s;
                BigInteger d = BigInteger.valueOf(d0).and(TWO64.subtract(BigInteger.ONE));
                v = BigInteger.ONE.shiftLeft(128).subtract(BigInteger.ONE).divide(d).subtract(TWO64).longValue();
            } else {
                s = Long.numberOfLeadingZeros(mHi);
                BigInteger d = m.shiftLeft(s);
                d1 = d.shiftRight(64).longValue();
                d0 = d.longValue();
                v = BigInteger.ONE.shiftLeft(192).subtract(BigInteger.ONE).divide(d).subtract(TWO64).longValue();
            }
        }
    }

    private static final class Params {
        int n;
        int t;
        int u;
        int v;
        int b;
        int d;
        final byte[] encP = new byte[BLOCK];
        boolean fast;
        Recip ru;
        Recip rv;
        BigInteger bigU;
        BigInteger bigV;
        int limbs;
        LMod lmU;
        LMod lmV;
    }

    private static final int MAXL = 64;

    /** A modulus for the limb path: little-endian limbs and its normalized form. */
    static final class LMod {
        final int n;
        final int s;
        final long[] m; // zero-padded to L limbs
        final long[] dn; // m << s
        final long vtop; // reciprocal of dn[n-1]

        LMod(BigInteger mod, int L) {
            m = new long[L];
            for (int i = 0; i < L; i++) {
                m[i] = mod.shiftRight(64 * i).longValue();
            }
            int nn = L;
            while (nn > 1 && m[nn - 1] == 0) {
                nn--;
            }
            n = nn;
            s = Long.numberOfLeadingZeros(m[n - 1]);
            dn = new long[n];
            for (int i = n - 1; i >= 0; i--) {
                dn[i] = (m[i] << s) | (s != 0 && i > 0 ? m[i - 1] >>> (64 - s) : 0);
            }
            BigInteger d = new BigInteger(Long.toUnsignedString(dn[n - 1]));
            vtop = BigInteger.ONE.shiftLeft(128).subtract(BigInteger.ONE).divide(d).subtract(TWO64).longValue();
        }
    }

    private final Aes aes;
    private final int radix;
    private final BigInteger bigRadix;
    private final int groupLen;
    private final long groupPow;
    private final Recip groupRecip;
    private final long magic;
    int forcePath; // testing only: 0 auto, 1 force limb path, 2 force BigInteger path
    private Params params;
    private final byte[] blk = new byte[BLOCK];
    // second result of the 2-word helpers below
    private long r2;

    public FF1(byte[] key, int radix) {
        this(key, radix, IntrinsicAes.available());
    }

    FF1(byte[] key, int radix, boolean intrinsicAes) {
        if (radix < 2 || radix > 65536) {
            throw new IllegalArgumentException("radix must be in [2, 65536]");
        }
        if (key.length != 16 && key.length != 24 && key.length != 32) {
            throw new IllegalArgumentException("key must be 16, 24 or 32 bytes");
        }
        this.aes = intrinsicAes ? new IntrinsicAes(key) : new JceAes(key);
        this.radix = radix;
        this.bigRadix = BigInteger.valueOf(radix);
        int g = 0;
        long p = 1;
        while (p <= Long.MAX_VALUE / radix) { // groups < 2^63
            p *= radix;
            g++;
        }
        this.groupLen = g;
        this.groupPow = p;
        this.groupRecip = new Recip(BigInteger.valueOf(p));
        this.magic = Long.divideUnsigned(-1L, radix) + 1; // ceil(2^64 / radix)
    }

    /** True if this JVM lets FF1 use the AES-NI intrinsic directly. */
    public static boolean intrinsicAesAvailable() {
        return IntrinsicAes.available();
    }

    public int[] encrypt(byte[] tweak, int[] x) {
        int[] out = new int[x.length];
        crypt(tweak, x, out, true);
        return out;
    }

    public int[] decrypt(byte[] tweak, int[] x) {
        int[] out = new int[x.length];
        crypt(tweak, x, out, false);
        return out;
    }

    /** Encrypts x into out (same length; may be the same array). */
    public void encrypt(byte[] tweak, int[] x, int[] out) {
        crypt(tweak, x, out, true);
    }

    /** Decrypts x into out (same length; may be the same array). */
    public void decrypt(byte[] tweak, int[] x, int[] out) {
        crypt(tweak, x, out, false);
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

    /** b = ceil(ceil(v*log2(radix))/8), exact (BouncyCastle calculateB_FF1); used by tests. */
    static int calcB(int radix, int v) {
        int tz = Integer.numberOfTrailingZeros(radix);
        int bits = tz * v;
        int odd = radix >>> tz;
        if (odd != 1) {
            bits += BigInteger.valueOf(odd).pow(v).bitLength();
        }
        return (bits + 7) / 8;
    }

    private Params makeParams(int n, int t) {
        Params p = new Params();
        p.n = n;
        p.t = t;
        p.u = n / 2;
        p.v = n - p.u;
        BigInteger mu = bigRadix.pow(p.u);
        BigInteger mv = p.v != p.u ? mu.multiply(bigRadix) : mu;
        p.b = (mv.subtract(BigInteger.ONE).bitLength() + 7) / 8;
        p.d = (p.b + 7) & ~3;
        p.fast = forcePath == 0 && mv.bitLength() <= 96;
        int L = (mv.bitLength() + 63) / 64;
        if (p.fast) {
            p.ru = new Recip(mu);
            p.rv = new Recip(mv);
        } else if (forcePath != 2 && L <= MAXL) {
            p.limbs = L;
            p.lmU = new LMod(mu, L);
            p.lmV = new LMod(mv, L);
            int vlen = 16 + 1 + p.b + 16;
            lv = new byte[vlen];
            ls = new byte[(p.d + BLOCK - 1) / BLOCK * BLOCK];
            la = new long[L];
            lb = new long[L];
            lr = new long[L];
            ly = new long[(p.d + 7) / 8];
            lun = new long[ly.length + 3];
        } else {
            p.bigU = mu;
            p.bigV = mv;
        }
        byte[] P = p.encP;
        P[0] = 1;
        P[1] = 2;
        P[2] = 1;
        P[3] = (byte) (radix >> 16);
        P[4] = (byte) (radix >> 8);
        P[5] = (byte) radix;
        P[6] = 10;
        P[7] = (byte) p.u;
        P[8] = (byte) (n >> 24);
        P[9] = (byte) (n >> 16);
        P[10] = (byte) (n >> 8);
        P[11] = (byte) n;
        P[12] = (byte) (t >> 24);
        P[13] = (byte) (t >> 16);
        P[14] = (byte) (t >> 8);
        P[15] = (byte) t;
        aes.encrypt(P, 0);
        return p;
    }

    private void crypt(byte[] T, int[] x, int[] out, boolean enc) {
        int n = x.length;
        int t = T.length;
        if (out.length != n) {
            throw new IllegalArgumentException("output length must equal input length");
        }
        Params p = params;
        boolean cached = p != null && p.n == n && p.t == t;
        if (!cached && !lengthOk(radix, n)) {
            throw new IllegalArgumentException("input length out of range (radix^n must be >= 1000000)");
        }
        for (int dgt : x) {
            if (dgt < 0 || dgt >= radix) {
                throw new IllegalArgumentException("digit out of range for radix");
            }
        }
        if (!cached) {
            p = makeParams(n, t);
            params = p;
        }
        int zeros = -(t + p.b + 1) & 15;
        int roundIdx = t + zeros;
        // CBC-MAC state after P and all Q blocks that hold only tweak/zero bytes.
        byte[] X = blk;
        System.arraycopy(p.encP, 0, X, 0, BLOCK);
        int off = 0;
        for (; off + BLOCK <= roundIdx; off += BLOCK) {
            for (int j = 0; j < BLOCK; j++) {
                if (off + j < t) {
                    X[j] ^= T[off + j];
                }
            }
            aes.encrypt(X, 0);
        }
        if (p.fast) {
            for (int j = 0; j < BLOCK; j++) {
                int k = off + j;
                if (k < roundIdx && k < t) {
                    X[j] ^= T[k];
                }
            }
            cryptFast(p, (long) LONG_BE.get(X, 0), (long) LONG_BE.get(X, 8), x, out, enc);
        } else if (p.limbs != 0) {
            cryptLimb(p, T, X.clone(), off, roundIdx, x, out, enc);
        } else {
            cryptBig(p, T, X.clone(), off, roundIdx, x, out, enc);
        }
    }

    // ---- limb path ----
    private byte[] lv;
    private byte[] ls;
    private long[] la;
    private long[] lb;
    private long[] lr;
    private long[] ly;
    private long[] lun;

    /** r (L limbs) = y mod M, Knuth algorithm D (remainder only). */
    private void limbRem(long[] y, LMod M, long[] r) {
        final int n = M.n;
        final int s = M.s;
        final int nly = y.length;
        Arrays.fill(r, 0);
        if (nly < n) {
            System.arraycopy(y, 0, r, 0, nly);
            return;
        }
        long[] un = lun;
        un[nly] = s != 0 ? y[nly - 1] >>> (64 - s) : 0;
        for (int i = nly - 1; i > 0; i--) {
            un[i] = (y[i] << s) | (s != 0 ? y[i - 1] >>> (64 - s) : 0);
        }
        un[0] = y[0] << s;
        final long[] dn = M.dn;
        final long dtop = dn[n - 1];
        final long dsec = n >= 2 ? dn[n - 2] : 0;
        for (int j = nly - n; j >= 0; j--) {
            long qhat;
            long rhat;
            boolean rhatOver;
            if (Long.compareUnsigned(un[j + n], dtop) < 0) {
                rhat = divrem2by1(un[j + n], un[j + n - 1], dtop, M.vtop);
                qhat = r2;
                rhatOver = false;
            } else {
                qhat = -1L;
                rhat = un[j + n - 1] + dtop;
                rhatOver = Long.compareUnsigned(rhat, dtop) < 0;
            }
            long u2 = j + n >= 2 ? un[j + n - 2] : 0;
            while (!rhatOver) {
                long ph = Math.unsignedMultiplyHigh(qhat, dsec);
                long pl = qhat * dsec;
                if (Long.compareUnsigned(ph, rhat) < 0 || (ph == rhat && Long.compareUnsigned(pl, u2) <= 0)) {
                    break;
                }
                qhat--;
                long nr = rhat + dtop;
                rhatOver = Long.compareUnsigned(nr, rhat) < 0;
                rhat = nr;
            }
            long borrow = 0;
            long carry = 0;
            for (int i = 0; i < n; i++) {
                long ph = Math.unsignedMultiplyHigh(qhat, dn[i]);
                long pl = qhat * dn[i];
                long pl2 = pl + carry;
                carry = ph + (Long.compareUnsigned(pl2, pl) < 0 ? 1 : 0);
                long u = un[i + j];
                long t = u - pl2;
                long b1 = Long.compareUnsigned(u, pl2) < 0 ? 1 : 0;
                long t2 = t - borrow;
                long b2 = Long.compareUnsigned(t, borrow) < 0 ? 1 : 0;
                un[i + j] = t2;
                borrow = b1 | b2;
            }
            long u = un[j + n];
            long t = u - carry;
            long b1 = Long.compareUnsigned(u, carry) < 0 ? 1 : 0;
            long b2 = Long.compareUnsigned(t, borrow) < 0 ? 1 : 0;
            un[j + n] = t - borrow;
            if ((b1 | b2) != 0) {
                long cy = 0;
                for (int i = 0; i < n; i++) {
                    long a = un[i + j];
                    long sm = a + dn[i];
                    long c1 = Long.compareUnsigned(sm, a) < 0 ? 1 : 0;
                    long sm2 = sm + cy;
                    long c2 = Long.compareUnsigned(sm2, sm) < 0 ? 1 : 0;
                    un[i + j] = sm2;
                    cy = c1 | c2;
                }
                un[j + n] += cy;
            }
        }
        for (int i = 0; i < n; i++) {
            r[i] = s != 0 ? (un[i] >>> s) | (un[i + 1] << (64 - s)) : un[i];
        }
    }

    private static void limbAddMod(long[] a, long[] r, long[] m) {
        long cy = 0;
        for (int i = 0; i < a.length; i++) {
            long x = a[i];
            long sm = x + r[i];
            long c1 = Long.compareUnsigned(sm, x) < 0 ? 1 : 0;
            long sm2 = sm + cy;
            long c2 = Long.compareUnsigned(sm2, sm) < 0 ? 1 : 0;
            a[i] = sm2;
            cy = c1 | c2;
        }
        boolean ge = cy != 0;
        if (!ge) {
            ge = true;
            for (int i = a.length - 1; i >= 0; i--) {
                if (a[i] != m[i]) {
                    ge = Long.compareUnsigned(a[i], m[i]) > 0;
                    break;
                }
            }
        }
        if (ge) {
            long bw = 0;
            for (int i = 0; i < a.length; i++) {
                long x = a[i];
                long t = x - m[i];
                long b1 = Long.compareUnsigned(x, m[i]) < 0 ? 1 : 0;
                long b2 = Long.compareUnsigned(t, bw) < 0 ? 1 : 0;
                a[i] = t - bw;
                bw = b1 | b2;
            }
        }
    }

    private static void limbSubMod(long[] a, long[] r, long[] m) {
        long bw = 0;
        for (int i = 0; i < a.length; i++) {
            long x = a[i];
            long t = x - r[i];
            long b1 = Long.compareUnsigned(x, r[i]) < 0 ? 1 : 0;
            long b2 = Long.compareUnsigned(t, bw) < 0 ? 1 : 0;
            a[i] = t - bw;
            bw = b1 | b2;
        }
        if (bw != 0) {
            long cy = 0;
            for (int i = 0; i < a.length; i++) {
                long x = a[i];
                long sm = x + m[i];
                long c1 = Long.compareUnsigned(sm, x) < 0 ? 1 : 0;
                long sm2 = sm + cy;
                long c2 = Long.compareUnsigned(sm2, sm) < 0 ? 1 : 0;
                a[i] = sm2;
                cy = c1 | c2;
            }
        }
    }

    private void cryptLimb(Params p, byte[] T, byte[] X, int off, int roundIdx, int[] x, int[] out, boolean enc) {
        final int b = p.b;
        final int d = p.d;
        final int t = T.length;
        final int vlen = roundIdx + 1 + b - off;
        final byte[] V = lv;
        for (int k = 0; k < vlen; k++) {
            int j = off + k;
            V[k] = (j < roundIdx && j < t) ? T[j] : 0;
        }
        final int ridx = roundIdx - off;
        final int noff = ridx + 1;
        final int nBlocks = (d + BLOCK - 1) / BLOCK;
        final byte[] S = ls;
        final byte[] R = new byte[BLOCK];
        long[] A = la;
        long[] B = lb;
        final long[] r = lr;
        final long[] y = ly;
        numLimbs(x, 0, p.u, A);
        numLimbs(x, p.u, p.n, B);
        final int fullB = b / 8;
        final int partB = b % 8;
        final int fullD = d / 8;
        for (int k = 0; k < 10; k++) {
            int i = enc ? k : 9 - k;
            long[] src = enc ? B : A;
            V[ridx] = (byte) i;
            for (int q = 0; q < fullB; q++) {
                LONG_BE.set(V, noff + b - 8 * (q + 1), src[q]);
            }
            for (int q = 0; q < partB; q++) {
                V[noff + partB - 1 - q] = (byte) (src[fullB] >>> (8 * q));
            }
            System.arraycopy(X, 0, R, 0, BLOCK);
            for (int o = 0; o < vlen; o += BLOCK) {
                for (int j = 0; j < BLOCK; j++) {
                    R[j] ^= V[o + j];
                }
                aes.encrypt(R, 0);
            }
            System.arraycopy(R, 0, S, 0, BLOCK);
            int j0 = ((R[12] & 0xff) << 24) | ((R[13] & 0xff) << 16) | ((R[14] & 0xff) << 8) | (R[15] & 0xff);
            for (int j = 1; j < nBlocks; j++) {
                int so = j * BLOCK;
                System.arraycopy(R, 0, S, so, 12);
                int w = j0 ^ j;
                S[so + 12] = (byte) (w >>> 24);
                S[so + 13] = (byte) (w >>> 16);
                S[so + 14] = (byte) (w >>> 8);
                S[so + 15] = (byte) w;
                aes.encrypt(S, so);
            }
            for (int q = 0; q < fullD; q++) {
                y[q] = (long) LONG_BE.get(S, d - 8 * (q + 1));
            }
            if ((d & 4) != 0) {
                y[fullD] = ((S[0] & 0xffL) << 24) | ((S[1] & 0xffL) << 16) | ((S[2] & 0xffL) << 8) | (S[3] & 0xffL);
            }
            LMod m = (i & 1) == 0 ? p.lmU : p.lmV;
            limbRem(y, m, r);
            if (enc) {
                limbAddMod(A, r, m.m);
            } else {
                limbSubMod(B, r, m.m);
            }
            long[] tmp = A;
            A = B;
            B = tmp;
        }
        strLimbs(A, out, 0, p.u);
        strLimbs(B, out, p.u, p.n);
    }

    private void numLimbs(int[] x, int from, int to, long[] res) {
        Arrays.fill(res, 0);
        for (int i = from; i < to; ) {
            int end = Math.min(i + groupLen, to);
            long acc = 0;
            long pw = 1;
            for (; i < end; i++) {
                acc = acc * radix + x[i];
                pw *= radix;
            }
            long cy = acc;
            for (int k = 0; k < res.length; k++) {
                long lo = res[k] * pw;
                long hi = Math.unsignedMultiplyHigh(res[k], pw);
                long lo2 = lo + cy;
                cy = hi + (Long.compareUnsigned(lo2, lo) < 0 ? 1 : 0);
                res[k] = lo2;
            }
        }
    }

    /** STR into out[from..to); destroys v. */
    private void strLimbs(long[] v, int[] out, int from, int to) {
        int i = to;
        int top = v.length;
        Recip g = groupRecip;
        int s = g.s;
        while (i > from) {
            while (top > 0 && v[top - 1] == 0) {
                top--;
            }
            // short division by groupPow, normalized by s (remainder stays shifted)
            long rem = 0;
            for (int k = top - 1; k >= 0; k--) {
                long u1 = rem | (s != 0 ? v[k] >>> (64 - s) : 0);
                long u0 = v[k] << s;
                rem = divrem2by1(u1, u0, g.d0, g.v);
                v[k] = r2;
            }
            i = strGroup(rem >>> s, out, from, i);
        }
    }

    // ---- 128-bit helpers (unsigned) ----

    /** Remainder of (u1:u0) / d, d normalized, u1 &lt; d, v = reciprocal of d. Quotient in r2. */
    private long divrem2by1(long u1, long u0, long d, long v) {
        long ql = v * u1;
        long qh = Math.unsignedMultiplyHigh(v, u1);
        long sl = ql + u0;
        long q1 = qh + u1 + (Long.compareUnsigned(sl, ql) < 0 ? 1 : 0) + 1;
        long r = u0 - q1 * d;
        if (Long.compareUnsigned(r, sl) > 0) {
            q1--;
            r += d;
        }
        if (Long.compareUnsigned(r, d) >= 0) {
            q1++;
            r -= d;
        }
        r2 = q1;
        return r;
    }

    /** (yHi:yLo) mod m; low word returned, high word in r2. */
    private long rem(long yHi, long yLo, Recip m) {
        int s = m.s;
        long u2 = s == 0 ? 0 : yHi >>> (64 - s);
        long u1 = (yHi << s) | (s == 0 ? 0 : yLo >>> (64 - s));
        long u0 = yLo << s;
        if (!m.wide) {
            long r = divrem2by1(u2, u1, m.d0, m.v);
            r = divrem2by1(r, u0, m.d0, m.v);
            r2 = 0;
            return r >>> s;
        }
        long d1 = m.d1;
        long d0 = m.d0;
        long ql = m.v * u2;
        long qh = Math.unsignedMultiplyHigh(m.v, u2);
        long q0 = ql + u1;
        long q1 = qh + u2 + (Long.compareUnsigned(q0, ql) < 0 ? 1 : 0);
        long r1 = u1 - q1 * d1;
        long tl = d0 * q1;
        long th = Math.unsignedMultiplyHigh(d0, q1);
        // r = (r1:u0) - (th:tl) - (d1:d0)
        long r0 = u0 - tl;
        r1 = r1 - th - (Long.compareUnsigned(u0, tl) < 0 ? 1 : 0);
        long r0b = r0 - d0;
        r1 = r1 - d1 - (Long.compareUnsigned(r0, d0) < 0 ? 1 : 0);
        r0 = r0b;
        if (Long.compareUnsigned(r1, q0) >= 0) {
            long n0 = r0 + d0;
            r1 = r1 + d1 + (Long.compareUnsigned(n0, r0) < 0 ? 1 : 0);
            r0 = n0;
        }
        if (Long.compareUnsigned(r1, d1) > 0 || (r1 == d1 && Long.compareUnsigned(r0, d0) >= 0)) {
            long n0 = r0 - d0;
            r1 = r1 - d1 - (Long.compareUnsigned(r0, d0) < 0 ? 1 : 0);
            r0 = n0;
        }
        // >> s
        r2 = r1 >>> s;
        return s == 0 ? r0 : (r0 >>> s) | (r1 << (64 - s));
    }

    private void cryptFast(Params p, long xh, long xl, int[] x, int[] out, boolean enc) {
        final int ishift = 8 * p.b; // 8..96
        final int yshift = 128 - 8 * p.d; // 0..64
        final byte[] b = blk;
        num128(x, 0, p.u);
        long aHi = r2;
        long aLo = numLo;
        num128(x, p.u, p.n);
        long bHi = r2;
        long bLo = numLo;
        for (int k = 0; k < 10; k++) {
            int i = enc ? k : 9 - k;
            long sHi = enc ? bHi : aHi;
            long sLo = enc ? bLo : aLo;
            long iHi = ishift >= 64 ? ((long) i) << (ishift - 64) : (((long) i) >>> (64 - ishift));
            long iLo = ishift >= 64 ? 0 : ((long) i) << ishift;
            LONG_BE.set(b, 0, xh ^ iHi ^ sHi);
            LONG_BE.set(b, 8, xl ^ iLo ^ sLo);
            aes.encrypt(b, 0);
            long rh = (long) LONG_BE.get(b, 0);
            long rl = (long) LONG_BE.get(b, 8);
            long yh;
            long yl;
            if (yshift == 0) {
                yh = rh;
                yl = rl;
            } else if (yshift == 64) {
                yh = 0;
                yl = rh;
            } else {
                yh = rh >>> yshift;
                yl = (rl >>> yshift) | (rh << (64 - yshift));
            }
            Recip m = (i & 1) == 0 ? p.ru : p.rv;
            yl = rem(yh, yl, m);
            yh = r2;
            if (enc) {
                // c = A + y; if c >= m: c -= m
                long cl = aLo + yl;
                long ch = aHi + yh + (Long.compareUnsigned(cl, aLo) < 0 ? 1 : 0);
                if (Long.compareUnsigned(ch, m.mHi) > 0 || (ch == m.mHi && Long.compareUnsigned(cl, m.mLo) >= 0)) {
                    long nl = cl - m.mLo;
                    ch = ch - m.mHi - (Long.compareUnsigned(cl, m.mLo) < 0 ? 1 : 0);
                    cl = nl;
                }
                aHi = bHi;
                aLo = bLo;
                bHi = ch;
                bLo = cl;
            } else {
                // c = B - y; if borrow: c += m
                long cl = bLo - yl;
                long ch = bHi - yh - (Long.compareUnsigned(bLo, yl) < 0 ? 1 : 0);
                if (ch < 0) { // values < 2^97, so the sign bit means borrow
                    long nl = cl + m.mLo;
                    ch = ch + m.mHi + (Long.compareUnsigned(nl, cl) < 0 ? 1 : 0);
                    cl = nl;
                }
                bHi = aHi;
                bLo = aLo;
                aHi = ch;
                aLo = cl;
            }
        }
        str128(aHi, aLo, out, 0, p.u);
        str128(bHi, bLo, out, p.u, p.n);
    }

    private long numLo;

    /** NUM_radix(x[from..to)) into (r2:numLo). */
    private void num128(int[] x, int from, int to) {
        long hi = 0;
        long lo = 0;
        for (int i = from; i < to; ) {
            int end = Math.min(i + groupLen, to);
            long acc = 0;
            long pw = 1;
            for (; i < end; i++) {
                acc = acc * radix + x[i];
                pw *= radix;
            }
            // (hi:lo) = (hi:lo) * pw + acc
            long nlo = lo * pw;
            long nhi = hi * pw + Math.unsignedMultiplyHigh(lo, pw);
            lo = nlo + acc;
            hi = nhi + (Long.compareUnsigned(lo, nlo) < 0 ? 1 : 0);
        }
        r2 = hi;
        numLo = lo;
    }

    /** w / radix for w &lt; 2^63: quotient returned, remainder in r2. */
    private long divRadix(long w) {
        long q = Math.unsignedMultiplyHigh(w, magic);
        long r = w - q * radix;
        if (Long.compareUnsigned(r, w) > 0) {
            q--;
            r += radix;
        }
        r2 = r;
        return q;
    }

    private int strGroup(long w, int[] out, int from, int i) {
        for (int k = 0; k < groupLen && i > from; k++) {
            w = divRadix(w);
            out[--i] = (int) r2;
        }
        return i;
    }

    private void str128(long hi, long lo, int[] out, int from, int to) {
        int i = to;
        Recip g = groupRecip;
        while (i > from) {
            long w;
            if (hi == 0 && Long.compareUnsigned(lo, groupPow) < 0) {
                w = lo;
                lo = 0;
            } else {
                // hi < 2^32 < groupPow, so one normalized 2-by-1 step gives (q, r).
                int s = g.s;
                long u1 = (hi << s) | (s == 0 ? 0 : lo >>> (64 - s));
                long u0 = lo << s;
                long r = divrem2by1(u1, u0, g.d0, g.v);
                w = r >>> s;
                lo = r2;
                hi = 0;
            }
            i = strGroup(w, out, from, i);
        }
    }

    private void cryptBig(Params p, byte[] T, byte[] X, int off, int roundIdx, int[] x, int[] out, boolean enc) {
        int b = p.b;
        int d = p.d;
        int t = T.length;
        int qlen = roundIdx + 1 + b;
        int vlen = qlen - off;
        byte[] V = new byte[vlen];
        for (int k = 0; k < vlen; k++) {
            int j = off + k;
            if (j < roundIdx && j < t) {
                V[k] = T[j];
            }
        }
        int ridx = roundIdx - off;
        int nBlocks = (d + BLOCK - 1) / BLOCK;
        byte[] S = new byte[nBlocks * BLOCK];
        byte[] R = new byte[BLOCK];
        BigInteger A = numBig(x, 0, p.u);
        BigInteger B = numBig(x, p.u, p.n);
        for (int k = 0; k < 10; k++) {
            int i = enc ? k : 9 - k;
            BigInteger src = enc ? B : A;
            V[ridx] = (byte) i;
            byte[] bs = src.toByteArray(); // may carry one leading 0x00 sign byte
            int copy = Math.min(bs.length, b);
            Arrays.fill(V, ridx + 1, vlen - copy, (byte) 0);
            System.arraycopy(bs, bs.length - copy, V, vlen - copy, copy);
            System.arraycopy(X, 0, R, 0, BLOCK);
            for (int o = 0; o < vlen; o += BLOCK) {
                for (int j = 0; j < BLOCK; j++) {
                    R[j] ^= V[o + j];
                }
                aes.encrypt(R, 0);
            }
            System.arraycopy(R, 0, S, 0, BLOCK);
            int j0 = ((R[12] & 0xff) << 24) | ((R[13] & 0xff) << 16) | ((R[14] & 0xff) << 8) | (R[15] & 0xff);
            for (int j = 1; j < nBlocks; j++) {
                int so = j * BLOCK;
                System.arraycopy(R, 0, S, so, 12);
                int w = j0 ^ j;
                S[so + 12] = (byte) (w >>> 24);
                S[so + 13] = (byte) (w >>> 16);
                S[so + 14] = (byte) (w >>> 8);
                S[so + 15] = (byte) w;
                aes.encrypt(S, so);
            }
            BigInteger y = new BigInteger(1, S, 0, d);
            BigInteger mod = (i & 1) == 0 ? p.bigU : p.bigV;
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
        strBig(A, out, 0, p.u);
        strBig(B, out, p.u, p.n);
    }

    /** NUM_radix(x[from..to)) in long-sized digit groups (BouncyCastle RadixConverter idea). */
    private BigInteger numBig(int[] x, int from, int to) {
        BigInteger res = BigInteger.ZERO;
        for (int i = from; i < to; ) {
            int end = Math.min(i + groupLen, to);
            long acc = 0;
            long pw = 1;
            for (; i < end; i++) {
                acc = acc * radix + x[i];
                pw *= radix;
            }
            res = res.multiply(BigInteger.valueOf(pw)).add(BigInteger.valueOf(acc));
        }
        return res;
    }

    private void strBig(BigInteger v, int[] out, int from, int to) {
        BigInteger gp = BigInteger.valueOf(groupPow);
        int i = to;
        while (i > from) {
            BigInteger[] qr = v.divideAndRemainder(gp);
            v = qr[0];
            i = strGroup(qr[1].longValue(), out, from, i);
        }
    }
}
