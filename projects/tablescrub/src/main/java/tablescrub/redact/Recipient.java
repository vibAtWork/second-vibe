package tablescrub.redact;

/** Who the export is for. It decides which GDPR checklist items apply. */
public enum Recipient {
    EEA_INSTITUTION("Research partner in the EU/EEA"),
    THIRD_COUNTRY("Research partner outside the EU/EEA"),
    AI_SERVICE("AI assistant / cloud AI service"),
    PUBLIC("Open / public release"),
    INTERNAL("Internal use (same organisation)");

    public final String label;

    Recipient(String label) { this.label = label; }

    public static Recipient parse(String s) {
        if (s == null || s.isBlank()) return EEA_INSTITUTION;
        try { return valueOf(s.strip().toUpperCase(java.util.Locale.ROOT)); }
        catch (IllegalArgumentException e) { return EEA_INSTITUTION; }
    }
}
