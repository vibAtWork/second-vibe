package tablescrub.io;

/** Limits applied while reading so a single upload cannot exhaust memory. */
public record ReadOptions(int maxRows, int maxColumns) {
    public static final ReadOptions DEFAULT = new ReadOptions(1_000_000, 2_000);
}
