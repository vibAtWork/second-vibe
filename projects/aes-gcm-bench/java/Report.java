import java.io.FileOutputStream;
import java.io.FileDescriptor;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * Renders a results CSV from run.sh as a human-friendly report.
 *
 *   java -cp build Report results/aes-gcm-STAMP.csv [--env FILE] [--color] [--ascii]
 *
 * If the CSV holds several rounds (--repeat), the best value per cell is shown.
 * Kept Java 17 compatible so it also runs on older JDKs natively.
 */
public class Report {
    static final String JAVA_EVP = "openssl-evp", NOREKEY = "openssl-evp-norekey", SPEED = "openssl-speed";

    static boolean color = false, ascii = false;
    static PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);

    record Cell(String impl, String op, int keyBits, int size) {}

    public static void main(String[] args) throws IOException {
        Path csv = null, env = null;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--env" -> env = Path.of(args[++i]);
                case "--color" -> color = true;
                case "--ascii" -> ascii = true;
                default -> csv = Path.of(args[i]);
            }
        }
        if (csv == null) {
            System.err.println("usage: Report results.csv [--env file] [--color] [--ascii]");
            System.exit(2);
        }
        if (env == null) {
            Path guess = Path.of(csv.toString().replaceAll("\\.csv$", ".env.txt"));
            if (Files.exists(guess)) env = guess;
        }

        Map<Cell, Double> best = new LinkedHashMap<>();
        TreeSet<Integer> sizes = new TreeSet<>();
        TreeSet<String> impls = new TreeSet<>(Comparator.comparingInt(Report::implRank).thenComparing(s -> s));
        TreeMap<Integer, List<String>> tables = new TreeMap<>(); // keyBits -> ops in order
        for (String line : Files.readAllLines(csv)) {
            String[] f = line.split(",");
            if (f.length != 7 || f[0].equals("impl")) continue;
            Cell c = new Cell(f[0], f[1], Integer.parseInt(f[2]), Integer.parseInt(f[3]));
            best.merge(c, Double.parseDouble(f[6]), Math::max);
            sizes.add(c.size());
            impls.add(c.impl());
            List<String> ops = tables.computeIfAbsent(c.keyBits(), k -> new ArrayList<>());
            if (!ops.contains(c.op())) ops.add(c.op());
        }
        if (best.isEmpty()) { System.err.println("no results in " + csv); System.exit(1); }
        String java = impls.stream().filter(s -> s.startsWith("java-")).findFirst().orElse(null);

        header(env, java);
        for (var t : tables.entrySet())
            for (String op : t.getValue().stream().sorted(Comparator.comparing(o -> o.equals("enc") ? 0 : 1)).toList())
                table(best, sizes, impls, java, t.getKey(), op);
        summary(best, sizes, java);
        legend(impls);
    }

    // ---------- sections ----------

    static void header(Path envFile, String java) throws IOException {
        Map<String, String> env = new LinkedHashMap<>();
        if (envFile != null)
            for (String l : Files.readAllLines(envFile)) {
                int i = l.indexOf('=');
                if (i > 0) env.put(l.substring(0, i).trim(), l.substring(i + 1).trim());
            }
        String title = "AES-GCM throughput: Java vs OpenSSL";
        println();
        println(" " + bold(title));
        println(" " + dim(rule(title.length())));
        row("CPU", env.get("cpu") == null ? null : env.get("cpu") + dim(" · " + env.getOrDefault("threads", "?") + " threads"));
        String flags = env.get("cpu_flags");
        if (flags != null && !(flags.contains("aes") && flags.contains("pclmulqdq")))
            flags += "  " + red("(no AES-NI/PCLMUL: software fallback!)");
        row("Crypto", flags);
        row("Java", env.get("java") == null ? null
                : env.get("java") + (java == null ? "" : dim(" · provider " + java.substring(5))));
        row("OpenSSL", env.get("openssl"));
        row("C compiler", env.get("cc"));
        StringBuilder m = new StringBuilder();
        if (env.containsKey("seconds")) m.append(env.get("seconds")).append(" s per cell");
        if (env.containsKey("repeat")) m.append(" · best of ").append(env.get("repeat"));
        String pin = env.get("pinned");
        m.append(pin == null || pin.equals("no") ? " · not pinned" : " · pinned to CPU " + pin);
        if (env.containsKey("governor")) m.append(" · governor ").append(env.get("governor"));
        row("Method", m.toString());
        row("Kernel", env.get("kernel"));
    }

    static void row(String k, String v) {
        if (v != null && !v.isBlank()) printf(" %-11s %s%n", dim(k), v);
    }

    static void table(Map<Cell, Double> best, TreeSet<Integer> sizes, TreeSet<String> impls, String java,
                      int keyBits, String op) {
        List<String> rowLabels = new ArrayList<>();
        List<String[]> rows = new ArrayList<>();
        List<String> rowStyle = new ArrayList<>();
        for (String impl : impls) {
            String[] r = new String[sizes.size()];
            int i = 0;
            for (int s : sizes) {
                Double v = best.get(new Cell(impl, op, keyBits, s));
                r[i++] = v == null ? "–" : String.format(Locale.ROOT, "%,d", Math.round(v));
            }
            rowLabels.add(label(impl));
            rows.add(r);
            rowStyle.add(impl);
        }
        int body = rows.size();
        if (java != null)
            for (String ref : new String[]{JAVA_EVP, NOREKEY}) {
                if (!impls.contains(ref)) continue;
                String[] r = new String[sizes.size()];
                int i = 0;
                for (int s : sizes) {
                    Double a = best.get(new Cell(java, op, keyBits, s)), b = best.get(new Cell(ref, op, keyBits, s));
                    r[i++] = a == null || b == null || b == 0 ? "–" : String.format(Locale.ROOT, "%.2f×", a / b);
                }
                rowLabels.add("Java ÷ " + label(ref).replace("OpenSSL ", ""));
                rows.add(r);
                rowStyle.add("ratio");
            }

        // best measured value per column among the real contenders (not the `openssl speed` reference)
        double[] colBest = new double[sizes.size()];
        int ci = 0;
        for (int s : sizes) {
            for (String impl : impls)
                if (!impl.equals(SPEED)) {
                    Double v = best.get(new Cell(impl, op, keyBits, s));
                    if (v != null) colBest[ci] = Math.max(colBest[ci], v);
                }
            ci++;
        }

        int lw = Math.max(rowLabels.stream().mapToInt(String::length).max().orElse(10), 14);
        int[] cw = new int[sizes.size()];
        String[] heads = sizes.stream().map(Report::human).toArray(String[]::new);
        for (int i = 0; i < cw.length; i++) {
            cw[i] = heads[i].length();
            for (String[] r : rows) cw[i] = Math.max(cw[i], r[i].length());
        }

        String opName = op.equals("enc") ? "encrypt" : "decrypt";
        String title = "AES-" + keyBits + "-GCM " + opName;
        int totalWidth = lw + 2 + 1 + Arrays.stream(cw).map(w -> w + 3).sum();
        String units = "MB/s, higher is better";
        println();
        println(" " + bold(title) + " ".repeat(Math.max(1, totalWidth - title.length() - units.length() + 1)) + dim(units));
        println(" " + line('┌', '┬', '┐', lw, cw));
        StringBuilder h = new StringBuilder(" " + v() + " " + pad("message size", lw, false) + " " + v());
        for (int i = 0; i < cw.length; i++) h.append(" ").append(bold(pad(heads[i], cw[i], true))).append(" ").append(v());
        println(h.toString());
        println(" " + line('├', '┼', '┤', lw, cw));
        for (int r = 0; r < rows.size(); r++) {
            if (r == body) println(" " + line('├', '┼', '┤', lw, cw));
            String style = rowStyle.get(r);
            StringBuilder sb = new StringBuilder(" " + v() + " ");
            String lab = pad(rowLabels.get(r), lw, false);
            sb.append(style.equals(SPEED) ? dim(lab) : style.startsWith("java-") ? bold(lab) : lab).append(" ").append(v());
            int i = 0;
            for (int s : sizes) {
                String cell = pad(rows.get(r)[i], cw[i], true);
                if (style.equals("ratio")) cell = ratioColor(rows.get(r)[i], cell);
                else if (style.equals(SPEED)) cell = dim(cell);
                else {
                    Double val = best.get(new Cell(style, op, keyBits, s));
                    if (val != null && val >= colBest[i] * 0.999) cell = color ? bold(cell) : cell;
                }
                sb.append(" ").append(cell).append(" ").append(v());
                i++;
            }
            println(sb.toString());
        }
        println(" " + line('└', '┴', '┘', lw, cw));
    }

    static void summary(Map<Cell, Double> best, TreeSet<Integer> sizes, String java) {
        if (java == null) return;
        println();
        println(" " + bold("Summary") + dim("  (geometric mean of Java ÷ OpenSSL across key sizes and directions)"));
        for (String ref : new String[]{JAVA_EVP, NOREKEY}) {
            List<String> parts = new ArrayList<>();
            for (String bucket : new String[]{"small", "large"}) {
                double logSum = 0;
                int n = 0;
                for (var e : best.entrySet()) {
                    Cell c = e.getKey();
                    if (!c.impl().equals(java)) continue;
                    boolean small = c.size() <= 1024;
                    if (small != bucket.equals("small")) continue;
                    Double b = best.get(new Cell(ref, c.op(), c.keyBits(), c.size()));
                    if (b == null || b == 0) continue;
                    logSum += Math.log(e.getValue() / b);
                    n++;
                }
                if (n == 0) continue;
                double g = Math.exp(logSum / n);
                parts.add(dim(bucket.equals("small") ? "≤1 KiB " : ">1 KiB ") + pad(verdict(g), 0, false));
            }
            if (!parts.isEmpty())
                printf(" %-31s %s%n", "vs " + label(ref) + ":", String.join(dim("  │  "), parts));
        }
    }

    static String verdict(double g) {
        if (g >= 1.05) return green(String.format(Locale.ROOT, "Java %.2f× faster", g));
        if (g <= 0.95) return red(String.format(Locale.ROOT, "OpenSSL %.2f× faster", 1 / g));
        return String.format(Locale.ROOT, "about even (%.2f×)", g);
    }

    static void legend(TreeSet<String> impls) {
        println();
        println(" " + dim("Every row is one-shot AEAD: one init + seal/open per message, 16-byte tag, no AAD."));
        println(" " + dim("OpenSSL EVP:        same steps as Java's Cipher.init+doFinal (key passed every message)."));
        println(" " + dim("EVP, key set once:  key set once, only the IV changes per message (tuned C usage)."));
        if (impls.contains(SPEED))
            println(" " + dim("openssl speed:      OpenSSL's own loop; what it redoes per message varies by version"
                    + " (3.5: key + IV + 13 B AAD)."));
        println(" " + dim("Why the numbers differ: see analysis/ANALYSIS.md."));
        println();
    }

    // ---------- helpers ----------

    static int implRank(String impl) {
        if (impl.startsWith("java-")) return 0;
        return switch (impl) { case JAVA_EVP -> 1; case NOREKEY -> 2; case SPEED -> 3; default -> 4; };
    }

    static String label(String impl) {
        if (impl.startsWith("java-")) return "Java " + impl.substring(5);
        return switch (impl) {
            case JAVA_EVP -> "OpenSSL EVP";
            case NOREKEY -> "OpenSSL EVP, key set once";
            case SPEED -> "openssl speed";
            default -> impl;
        };
    }

    static String human(int s) {
        if (s >= 1 << 20 && s % (1 << 20) == 0) return (s >> 20) + " MiB";
        if (s >= 1024 && s % 1024 == 0) return (s >> 10) + " KiB";
        return s + " B";
    }

    static String pad(String s, int w, boolean right) {
        String p = " ".repeat(Math.max(0, w - s.length()));
        return right ? p + s : s + p;
    }

    static String line(char l, char m, char r, int lw, int[] cw) {
        if (ascii) { l = m = r = '+'; }
        String hz = ascii ? "-" : "─";
        StringBuilder sb = new StringBuilder().append(l).append(hz.repeat(lw + 2)).append(m);
        for (int i = 0; i < cw.length; i++) sb.append(hz.repeat(cw[i] + 2)).append(i == cw.length - 1 ? r : m);
        return dim(sb.toString());
    }

    static void println() { println(""); }
    static void println(String s) {
        if (ascii) s = s.replace("×", "x").replace("÷", "/").replace("·", "-").replace("≤", "<=").replace("–", "-");
        out.println(s);
    }
    static void printf(String fmt, Object... a) {
        String s = String.format(Locale.ROOT, fmt, a);
        println(s.endsWith("\n") ? s.substring(0, s.length() - 1) : s);
    }

    static String rule(int n) { return (ascii ? "-" : "─").repeat(n); }
    static String v() { return dim(ascii ? "|" : "│"); }

    static String ratioColor(String raw, String padded) {
        if (!raw.endsWith("×")) return padded;
        double x = Double.parseDouble(raw.substring(0, raw.length() - 1));
        return x >= 1.05 ? green(padded) : x <= 0.95 ? red(padded) : padded;
    }

    static String sgr(String code, String s) { return color ? "\033[" + code + "m" + s + "\033[0m" : s; }
    static String bold(String s) { return sgr("1", s); }
    static String dim(String s) { return sgr("2", s); }
    static String green(String s) { return sgr("32", s); }
    static String red(String s) { return sgr("31", s); }
}
