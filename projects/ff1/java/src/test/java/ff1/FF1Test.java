package ff1;

import static org.junit.jupiter.api.Assertions.*;

import java.math.BigInteger;
import java.util.HexFormat;
import java.util.Random;
import org.junit.jupiter.api.Test;

class FF1Test {
    static final String ALPHA = "0123456789abcdefghijklmnopqrstuvwxyz";
    static final String K128 = "2B7E151628AED2A6ABF7158809CF4F3C";
    static final String K192 = K128 + "EF4359D8D580AA4F";
    static final String K256 = K192 + "7F036D6F04FC6A94";
    static final String T1 = "39383736353433323130";
    static final String T2 = "3737373770717273373737";

    static int[] parse(String s) {
        return s.chars().map(ALPHA::indexOf).toArray();
    }

    static String fmt(int[] x) {
        StringBuilder sb = new StringBuilder();
        for (int d : x) sb.append(ALPHA.charAt(d));
        return sb.toString();
    }

    static byte[] hex(String s) {
        return HexFormat.of().parseHex(s);
    }

    @Test
    void nistVectors() {
        Object[][] v = {
            {K128, "", 10, "0123456789", "2433477484"},
            {K128, T1, 10, "0123456789", "6124200773"},
            {K128, T2, 36, "0123456789abcdefghi", "a9tv40mll9kdu509eum"},
            {K192, "", 10, "0123456789", "2830668132"},
            {K192, T1, 10, "0123456789", "2496655549"},
            {K192, T2, 36, "0123456789abcdefghi", "xbj3kv35jrawxv32ysr"},
            {K256, "", 10, "0123456789", "6657667009"},
            {K256, T1, 10, "0123456789", "1001623463"},
            {K256, T2, 36, "0123456789abcdefghi", "xs8a0azh2avyalyzuwd"},
        };
        for (int i = 0; i < v.length; i++) {
            FF1 c = new FF1(hex((String) v[i][0]), (Integer) v[i][2]);
            byte[] tw = hex((String) v[i][1]);
            assertEquals(v[i][4], fmt(c.encrypt(tw, parse((String) v[i][3]))), "sample " + (i + 1));
            assertEquals(v[i][3], fmt(c.decrypt(tw, parse((String) v[i][4]))), "sample " + (i + 1));
        }
    }

    @Test
    void roundTripRandom() {
        Random rng = new Random(1);
        int[] radices = {2, 3, 10, 16, 26, 36, 62, 255, 256, 1000, 65535, 65536};
        for (int it = 0; it < 400; it++) {
            int radix = radices[it % radices.length];
            byte[] key = new byte[new int[] {16, 24, 32}[it % 3]];
            rng.nextBytes(key);
            byte[] tw = new byte[rng.nextInt(40)];
            rng.nextBytes(tw);
            int n = 2 + rng.nextInt(150);
            if (!FF1.lengthOk(radix, n)) continue;
            int[] x = rng.ints(n, 0, radix).toArray();
            FF1 c = new FF1(key, radix);
            assertArrayEquals(x, c.decrypt(tw, c.encrypt(tw, x)));
        }
    }

    @Test
    void calcBExact() {
        for (int r : new int[] {2, 3, 7, 8, 10, 16, 36, 64, 255, 256, 1000, 65536}) {
            for (int v = 1; v < 80; v++) {
                int want = (BigInteger.valueOf(r).pow(v).subtract(BigInteger.ONE).bitLength() + 7) / 8;
                assertEquals(want, FF1.calcB(r, v), "r=" + r + " v=" + v);
            }
        }
    }

    @Test
    void validation() {
        assertThrows(IllegalArgumentException.class, () -> new FF1(new byte[16], 1));
        assertThrows(IllegalArgumentException.class, () -> new FF1(new byte[15], 10));
        FF1 c = new FF1(new byte[16], 10);
        assertThrows(IllegalArgumentException.class, () -> c.encrypt(new byte[0], parse("12345")));
        assertThrows(IllegalArgumentException.class, () -> c.encrypt(new byte[0], new int[] {1, 2, 3, 4, 5, 6, 10}));
    }
}
