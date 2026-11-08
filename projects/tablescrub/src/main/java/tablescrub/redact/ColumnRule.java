package tablescrub.redact;

/**
 * Redaction rule for one column.
 *
 * @param action          what to do
 * @param param           action-specific parameter, may be blank
 * @param quasiIdentifier include this column in the k-anonymity check
 * @param description     free-text documentation that goes into the data dictionary
 * @param rename          optional new column name for the export (blank = keep)
 */
public record ColumnRule(Action action, String param, boolean quasiIdentifier, String description, String rename) {
    public static final ColumnRule KEEP = new ColumnRule(Action.KEEP, "", false, "", "");

    public ColumnRule {
        if (action == null) action = Action.KEEP;
        if (param == null) param = "";
        if (description == null) description = "";
        if (rename == null) rename = "";
    }
}
