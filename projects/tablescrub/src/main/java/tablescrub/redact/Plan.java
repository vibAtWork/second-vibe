package tablescrub.redact;

import java.util.List;

/**
 * Everything the user chose for one export.
 *
 * @param rules        one rule per source column (same order as the table)
 * @param secret       key for HASH; must be kept private by the data owner, never exported
 * @param kThreshold   minimum acceptable equivalence-class size for the quasi-identifiers
 * @param suppressRows drop rows whose quasi-identifier combination occurs fewer than kThreshold times
 * @param title        dataset title for documentation
 * @param description  dataset description for documentation
 * @param license      licence / usage terms text
 */
public record Plan(List<ColumnRule> rules, byte[] secret, int kThreshold, boolean suppressRows,
                   String title, String description, String license) {

    public ColumnRule rule(int i) {
        return i < rules.size() ? rules.get(i) : ColumnRule.KEEP;
    }
}
