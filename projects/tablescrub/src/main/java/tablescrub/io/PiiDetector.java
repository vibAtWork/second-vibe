package tablescrub.io;

import tablescrub.model.Column;
import tablescrub.model.ColumnType;
import tablescrub.model.PiiHint;
import tablescrub.model.PiiHint.Level;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.Predicate;
import java.util.regex.Pattern;

/**
 * Heuristic detection of personal / sensitive data. Combines header keywords
 * (English, Danish, Swedish, Norwegian, German, Dutch) with value patterns.
 * These are suggestions only – a human must review every column before sharing.
 */
public final class PiiDetector {
    private PiiDetector() {}

    private static final Pattern EMAIL = Pattern.compile("[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}");
    private static final Pattern CPR = Pattern.compile("(\\d{2})(\\d{2})\\d{2}-?\\d{4}");
    private static final Pattern SSN = Pattern.compile("\\d{3}-\\d{2}-\\d{4}");
    private static final Pattern PHONE = Pattern.compile("\\+?\\(?\\d[\\d ().-]{6,}\\d");
    private static final Pattern IPV4 = Pattern.compile("(25[0-5]|2[0-4]\\d|1?\\d?\\d)(\\.(25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}");
    private static final Pattern IBAN = Pattern.compile("[A-Z]{2}\\d{2} ?[A-Z0-9 ]{10,32}");

    private record Rule(Set<String> phrases, String category, Level level, String suggestion) {}

    /** Header rules, checked in order; first match wins. Phrases are matched on whole tokens. */
    private static final List<Rule> HEADER_RULES = List.of(
            rule("national id", Level.DIRECT, "HASH", "cpr", "cpr nr", "cprnr", "ssn", "social security", "personnummer",
                    "personal number", "national id", "nin", "bsn", "nhs number", "fodselsnummer", "personal id",
                    "steuer id", "sozialversicherungsnummer", "insurance number", "passport"),
            rule("email", Level.DIRECT, "DROP", "email", "e mail", "mail", "email address", "e post", "epost"),
            rule("phone", Level.DIRECT, "DROP", "phone", "telephone", "tlf", "mobile", "mobil", "cell phone", "fax",
                    "telefon", "telefonnummer", "phone number"),
            rule("person name", Level.DIRECT, "DROP", "name", "full name", "first name", "last name", "given name",
                    "family name", "surname", "middle name", "firstname", "lastname", "fullname", "patient name",
                    "participant name", "subject name", "contact name", "navn", "fornavn", "efternavn", "mellemnavn",
                    "fullt navn", "etternavn", "efternamn", "fornamn", "vorname", "nachname", "achternaam", "voornaam",
                    "initials", "initialer"),
            rule("address", Level.DIRECT, "DROP", "address", "street", "street address", "adresse", "adress", "vej",
                    "gade", "strasse", "straat", "home address", "address line"),
            rule("ip address", Level.DIRECT, "DROP", "ip", "ip address", "ipaddress", "ip addr"),
            rule("financial account", Level.DIRECT, "DROP", "iban", "account number", "card number", "credit card",
                    "kontonummer", "bank account"),
            rule("geolocation", Level.DIRECT, "GENERALIZE", "latitude", "longitude", "lat", "lon", "lng", "gps", "coordinates"),
            rule("record identifier", Level.DIRECT, "PSEUDONYM", "patient id", "patientid", "mrn", "medical record",
                    "medical record number", "subject id", "participant id", "person id", "personid", "user id", "userid",
                    "customer id", "employee id", "student id", "member id", "case id", "journal nr", "journalnummer",
                    "sample id", "specimen id"),
            rule("birth date", Level.QUASI, "GENERALIZE", "dob", "date of birth", "birth date", "birthdate", "birthday",
                    "born", "fodselsdato", "fodselsdag", "geburtsdatum", "fodelsedatum", "birth year", "year of birth"),
            rule("death date", Level.QUASI, "GENERALIZE", "date of death", "death date", "dod", "dodsdato"),
            rule("postal code", Level.QUASI, "GENERALIZE", "zip", "zipcode", "zip code", "postal code", "postcode",
                    "post code", "postnummer", "postnr", "plz", "postleitzahl"),
            rule("age", Level.QUASI, "GENERALIZE", "age", "alder", "alter", "leeftijd", "age years"),
            rule("sex / gender", Level.QUASI, "KEEP", "sex", "gender", "kon", "kjonn", "geschlecht", "geslacht"),
            rule("ethnicity", Level.QUASI, "KEEP", "ethnicity", "race", "ethnic", "etnicitet", "ethnic group"),
            rule("nationality", Level.QUASI, "KEEP", "nationality", "citizenship", "nationalitet", "country of birth"),
            rule("location", Level.QUASI, "KEEP", "city", "town", "municipality", "kommune", "region", "county",
                    "district", "village", "stadt", "ort", "neighbourhood", "neighborhood"),
            rule("occupation", Level.QUASI, "KEEP", "occupation", "job", "job title", "profession", "employer", "stilling", "beruf"),
            rule("event date", Level.QUASI, "GENERALIZE", "admission date", "discharge date", "visit date",
                    "diagnosis date", "date of diagnosis", "surgery date", "indlaeggelsesdato", "udskrivelsesdato"));

    private static Rule rule(String category, Level level, String suggestion, String... phrases) {
        return new Rule(Set.of(phrases), category, level, suggestion);
    }

    public static PiiHint detect(Column col, List<String[]> rows) {
        PiiHint byValues = detectByValues(col, rows);
        if (byValues != null && byValues.level() == Level.DIRECT && !"record identifier".equals(byValues.category()))
            return byValues;
        PiiHint byHeader = detectByHeader(col);
        if (byHeader != null) return byHeader;
        if (byValues != null) return byValues;
        return PiiHint.NONE;
    }

    static PiiHint detectByHeader(Column col) {
        List<String> tokens = tokens(col.name());
        if (tokens.isEmpty()) return null;
        for (Rule r : HEADER_RULES) {
            for (String phrase : r.phrases()) {
                if (containsPhrase(tokens, phrase.split(" "))) {
                    if (phrase.equals("name") && !personName(tokens)) continue;
                    String suggestion = r.suggestion();
                    if ("GENERALIZE".equals(suggestion) && col.type() == ColumnType.STRING && !"postal code".equals(r.category()))
                        suggestion = "SUPPRESS_RARE";
                    return new PiiHint(r.category(), "column name matches \"" + phrase + "\"", r.level(), suggestion);
                }
            }
        }
        // generic "...id" columns: likely a key into some other system.
        String last = tokens.getLast();
        if ((last.equals("id") || last.equals("nr") || last.equals("no") || last.equals("number")) && col.unique())
            return new PiiHint("record identifier", "unique values in an ID-like column", Level.QUASI, "PSEUDONYM");
        return null;
    }

    static PiiHint detectByValues(Column col, List<String[]> rows) {
        if (col.nonNull() == 0) return null;
        List<String> sample = new ArrayList<>();
        for (String[] r : rows) {
            if (r[col.index()] != null) sample.add(r[col.index()]);
            if (sample.size() >= 500) break;
        }
        if (share(sample, v -> EMAIL.matcher(v).matches()) >= 0.6)
            return new PiiHint("email", "values look like e-mail addresses", Level.DIRECT, "DROP");
        if (col.type() == ColumnType.STRING || col.type() == ColumnType.INTEGER) {
            if (share(sample, PiiDetector::looksLikeCpr) >= 0.8)
                return new PiiHint("national id", "values look like Danish CPR numbers", Level.DIRECT, "HASH");
            if (share(sample, v -> SSN.matcher(v).matches()) >= 0.8)
                return new PiiHint("national id", "values look like US social security numbers", Level.DIRECT, "HASH");
        }
        if (col.type() == ColumnType.STRING) {
            if (share(sample, v -> IPV4.matcher(v).matches()) >= 0.8)
                return new PiiHint("ip address", "values look like IPv4 addresses", Level.DIRECT, "DROP");
            if (share(sample, v -> IBAN.matcher(v).matches()) >= 0.8)
                return new PiiHint("financial account", "values look like IBANs", Level.DIRECT, "DROP");
            if (share(sample, PiiDetector::looksLikePhone) >= 0.8)
                return new PiiHint("phone", "values look like phone numbers", Level.DIRECT, "DROP");
            double avgLen = sample.stream().mapToInt(String::length).average().orElse(0);
            double withSpaces = share(sample, v -> v.trim().contains(" "));
            if (avgLen > 40 && withSpaces > 0.8)
                return new PiiHint("free text", "long free text often contains names or other identifiers",
                        Level.DIRECT, "DROP");
            if (col.unique() && col.nonNull() >= 10)
                return new PiiHint("record identifier", "every value is unique", Level.QUASI, "PSEUDONYM");
        }
        return null;
    }

    static boolean looksLikeCpr(String v) {
        var m = CPR.matcher(v);
        if (!m.matches()) return false;
        int day = Integer.parseInt(m.group(1)), month = Integer.parseInt(m.group(2));
        return day >= 1 && day <= 31 && month >= 1 && month <= 12;
    }

    static boolean looksLikePhone(String v) {
        if (!PHONE.matcher(v).matches() || Profiler.isIsoDate(v)) return false;
        long digits = v.chars().filter(Character::isDigit).count();
        boolean formatted = v.startsWith("+") || v.startsWith("(") || v.contains(" ");
        return digits >= 8 && digits <= 15 && formatted;
    }

    private static double share(List<String> values, Predicate<String> p) {
        if (values.isEmpty()) return 0;
        return (double) values.stream().filter(p).count() / values.size();
    }

    /** Splits "PatientFirstName", "date_of_birth", "Fødselsdato" into lowercase ASCII tokens. */
    static List<String> tokens(String header) {
        String s = header.replaceAll("([a-z])([A-Z])", "$1 $2");
        s = s.toLowerCase(Locale.ROOT).replace("ø", "o").replace("æ", "ae").replace("å", "a").replace("ß", "ss");
        s = Normalizer.normalize(s, Normalizer.Form.NFD).replaceAll("\\p{M}", "");
        List<String> out = new ArrayList<>();
        for (String t : s.split("[^a-z0-9]+")) if (!t.isEmpty()) out.add(t);
        return out;
    }

    private static final Set<String> PERSON_WORDS = Set.of("patient", "participant", "subject", "person", "contact",
            "client", "customer", "employee", "user", "mother", "father", "parent", "child", "owner", "respondent",
            "student", "member", "doctor", "physician", "nurse", "guardian", "spouse", "partner", "full", "your");

    /** Bare "name" is only personal when it stands alone ("Name") or next to a person word ("patient name"). */
    private static boolean personName(List<String> tokens) {
        return tokens.size() == 1 || tokens.stream().anyMatch(PERSON_WORDS::contains);
    }

    private static boolean containsPhrase(List<String> tokens, String[] phrase) {
        outer:
        for (int i = 0; i + phrase.length <= tokens.size(); i++) {
            for (int j = 0; j < phrase.length; j++) if (!tokens.get(i + j).equals(phrase[j])) continue outer;
            return true;
        }
        return false;
    }
}
