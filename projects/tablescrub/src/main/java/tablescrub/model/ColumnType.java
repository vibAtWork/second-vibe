package tablescrub.model;

/** Logical column types of the intermediate representation. */
public enum ColumnType {
    EMPTY, BOOLEAN, INTEGER, DECIMAL, DATE, DATETIME, STRING;

    /** Frictionless Table Schema type name. */
    public String frictionless() {
        return switch (this) {
            case EMPTY, STRING -> "string";
            case BOOLEAN -> "boolean";
            case INTEGER -> "integer";
            case DECIMAL -> "number";
            case DATE -> "date";
            case DATETIME -> "datetime";
        };
    }

    public boolean numeric() {
        return this == INTEGER || this == DECIMAL;
    }
}
