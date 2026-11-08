package tablescrub.model;

/**
 * GDPR categories that carry extra obligations beyond ordinary personal data.
 * Art. 9(1) special categories, Art. 10 criminal-offence data and Art. 87 national identifiers.
 */
public enum SpecialCategory {
    HEALTH("health data", "Art. 9"),
    GENETIC("genetic data", "Art. 9"),
    BIOMETRIC("biometric data", "Art. 9"),
    ETHNIC_ORIGIN("racial or ethnic origin", "Art. 9"),
    POLITICAL("political opinions", "Art. 9"),
    RELIGION("religious or philosophical beliefs", "Art. 9"),
    TRADE_UNION("trade union membership", "Art. 9"),
    SEX_LIFE("sex life or sexual orientation", "Art. 9"),
    CRIMINAL("criminal convictions and offences", "Art. 10"),
    NATIONAL_ID("national identification number", "Art. 87");

    public final String label;
    public final String article;

    SpecialCategory(String label, String article) {
        this.label = label;
        this.article = article;
    }

    public String tag() { return article + " · " + label; }

    public boolean article9() { return "Art. 9".equals(article); }
}
