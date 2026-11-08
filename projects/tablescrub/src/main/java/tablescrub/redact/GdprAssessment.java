package tablescrub.redact;

import tablescrub.model.PiiHint.Level;
import tablescrub.model.SpecialCategory;
import tablescrub.redact.RedactedTable.KStats;
import tablescrub.redact.RedactedTable.OutColumn;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Rough GDPR classification of an export under Regulation (EU) 2016/679, with a checklist for the chosen
 * recipient. It works from what is left in the output (identifiers kept, pseudonyms, k-anonymity,
 * special categories). Automated guidance only, not legal advice.
 *
 * @param status     overall classification
 * @param summary    one-sentence explanation of the status
 * @param findings   facts about this export
 * @param checklist  things the data owner should confirm before sharing
 * @param specials   special-category / Art. 10 / Art. 87 data present in the output
 */
public record GdprAssessment(Status status, String summary, List<String> findings, List<String> checklist,
                             List<SpecialCategory> specials) {

    public static final String REGULATION_URL = "https://eur-lex.europa.eu/eli/reg/2016/679/oj";
    public static final String DISCLAIMER =
            "Automated guidance based on the column treatments chosen, not legal advice. Confirm with your Data Protection Officer.";

    public enum Status {
        PERSONAL("Personal data", "bad"),
        PSEUDONYMISED("Pseudonymised personal data", "warn"),
        AT_RISK("Probably still personal data", "warn"),
        ANONYMISATION_CANDIDATE("Anonymisation candidate", "ok");

        public final String label;
        public final String css;

        Status(String label, String css) {
            this.label = label;
            this.css = css;
        }
    }

    private static final Set<Action> STILL_IDENTIFYING = EnumSet.of(Action.KEEP, Action.ROUND, Action.SUPPRESS_RARE);

    public static GdprAssessment assess(RedactedTable t) {
        List<String> findings = new ArrayList<>();
        List<String> checklist = new ArrayList<>();
        Recipient recipient = t.plan().recipient();
        KStats k = t.kStats();

        List<String> directKept = new ArrayList<>(), directGeneralised = new ArrayList<>();
        boolean hashed = false, pseudonym = false, nationalIdHashed = false;
        Set<SpecialCategory> specials = new LinkedHashSet<>();
        for (OutColumn c : t.columns()) {
            if (c.action() == Action.HASH) hashed = true;
            if (c.action() == Action.PSEUDONYM) pseudonym = true;
            if (c.piiLevel() == Level.DIRECT) {
                if (STILL_IDENTIFYING.contains(c.action())) directKept.add(c.originalName());
                else if (c.action() == Action.GENERALIZE) directGeneralised.add(c.originalName());
            }
            if (c.special() != null && c.action() != Action.MASK) {
                if (c.special() == SpecialCategory.NATIONAL_ID && (c.action() == Action.HASH || c.action() == Action.PSEUDONYM))
                    nationalIdHashed = true;
                else specials.add(c.special());
            }
        }

        Status status;
        String summary;
        if (!directKept.isEmpty()) {
            status = Status.PERSONAL;
            summary = "Direct identifiers remain (" + String.join(", ", directKept) + "), so GDPR applies in full to this export (Art. 4(1)).";
        } else if (hashed || pseudonym) {
            status = Status.PSEUDONYMISED;
            summary = "Identifiers are replaced by hashes or pseudonyms. Under Art. 4(5) and Recital 26 this is still personal data, "
                    + "because it can be re-linked using additional information (the key or mapping).";
        } else if (!k.enabled() || !k.ok() || !directGeneralised.isEmpty()) {
            status = Status.AT_RISK;
            summary = !k.enabled()
                    ? "Direct identifiers are gone, but re-identification risk has not been assessed: no quasi-identifiers are marked."
                    : !k.ok() ? "Direct identifiers are gone, but some combinations of quasi-identifiers are rarer than k = "
                            + k.threshold() + ", so people may be singled out."
                    : "Some direct identifiers were only generalised (" + String.join(", ", directGeneralised) + "); check they no longer identify anyone.";
        } else {
            status = Status.ANONYMISATION_CANDIDATE;
            summary = "No direct identifiers or pseudonyms remain, and k = " + k.k() + " over the marked quasi-identifiers meets the target. "
                    + "The data may be anonymous and therefore outside GDPR (Recital 26), but that depends on context.";
        }

        // ---- findings ----
        int total = t.columns().size() + t.dropped().size();
        findings.add(t.dropped().size() + " of " + total + " columns dropped. Data minimisation (Art. 5(1)(c)) means keeping only what the recipient needs.");
        if (k.enabled())
            findings.add("k-anonymity: k = " + k.k() + " over " + String.join(", ", k.quasiIdentifiers()) + " (target " + k.threshold() + ").");
        for (SpecialCategory s : specials) findings.add(s.tag() + " present.");
        if (nationalIdHashed)
            findings.add("A national identification number was hashed or pseudonymised (Art. 87 allows national rules on these identifiers).");
        if (hashed) findings.add("Keyed hashes: whoever holds the secret can re-link records.");
        if (pseudonym) findings.add("Sequential pseudonyms: the mapping is not exported and is discarded with the upload.");

        // ---- checklist ----
        boolean personal = status != Status.ANONYMISATION_CANDIDATE;
        if (personal) {
            checklist.add("Legal basis for this disclosure under Art. 6. Reuse for research is compatible with the original purpose only with Art. 89(1) safeguards (Art. 5(1)(b)).");
            if (specials.stream().anyMatch(SpecialCategory::article9))
                checklist.add("Special categories (Art. 9): you also need an Art. 9(2) condition. For research this is usually Art. 9(2)(j), "
                        + "based on Union or Member State law with Art. 89(1) safeguards. National law may add conditions for genetic, biometric or health data (Art. 9(4)).");
            if (specials.contains(SpecialCategory.CRIMINAL))
                checklist.add("Criminal-offence data (Art. 10) may only be processed under official authority or where Union or Member State law authorises it.");
            if (specials.contains(SpecialCategory.NATIONAL_ID) || nationalIdHashed)
                checklist.add("National identification numbers (Art. 87): check your Member State's specific rules before disclosing them, even in hashed form.");
            checklist.add("Every remaining column is necessary for the stated purpose (Art. 5(1)(c); Art. 89(1) asks for minimisation and, where possible, data that no longer identifies anyone).");
            checklist.add("Transparency: data subjects have been informed, or an exemption such as Art. 14(5)(b) for research applies.");
            checklist.add("The disclosure is recorded in your records of processing (Art. 30) and the transfer is secured, e.g. encrypted (Art. 32).");
            if (!specials.isEmpty() && specials.stream().anyMatch(SpecialCategory::article9))
                checklist.add("A DPIA may be required for large-scale processing of special categories (Art. 35(3)(b)).");
            if (hashed)
                checklist.add("The linkage secret is stored separately from the data and protected (Art. 4(5)), and is never sent to the recipient.");
        }
        switch (recipient) {
            case EEA_INSTITUTION -> {
                if (personal)
                    checklist.add("Agreement with the recipient: a data processing agreement if they act on your behalf (Art. 28(3)), "
                            + "a joint-controller arrangement if you decide purposes and means together (Art. 26), "
                            + "or otherwise a data-sharing agreement between independent controllers.");
            }
            case THIRD_COUNTRY -> {
                if (personal)
                    checklist.add("Transfer outside the EU/EEA: Chapter V (Art. 44-49) applies, pseudonymised data included. You need an adequacy decision (Art. 45) "
                            + "or appropriate safeguards such as standard contractual clauses (Art. 46). The Art. 49 derogations are narrow.");
                if (personal)
                    checklist.add("Agreement with the recipient covering their role (Art. 26 or Art. 28) and onward transfers.");
            }
            case AI_SERVICE -> {
                if (personal) {
                    checklist.add("Sending personal data to an AI service makes the provider a recipient. Use only a service your institution has approved, "
                            + "under a data processing agreement (Art. 28), and never a personal or consumer account.");
                    checklist.add("Check where the provider processes data (Chapter V transfers) and whether prompts and files are retained or used for training.");
                    checklist.add("Prefer an anonymised extract: often aggregated or generalised data is enough for analysis help.");
                } else {
                    checklist.add("Even for anonymised data, check your institution's AI policy and the data-use terms you received the data under.");
                }
            }
            case PUBLIC -> {
                if (personal)
                    checklist.add("DO NOT publish this export openly. Only anonymous data can be released without restriction; "
                            + "use controlled access (data-use agreement, secure environment) instead.");
                else
                    checklist.add("Before open release, document the anonymisation assessment: a motivated-intruder test, attribute disclosure "
                            + "(e.g. everyone in a group sharing the same diagnosis), and linkage with other public datasets.");
            }
            case INTERNAL -> {
                if (personal)
                    checklist.add("Internal reuse is still processing: purpose limitation (Art. 5(1)(b)) and access control (Art. 32) apply.");
            }
        }
        if (!personal)
            checklist.add("Recital 26: data is anonymous only if identification is not reasonably likely using all available means (cost, time, technology, "
                    + "other datasets) by anyone, the recipient included. Document this judgement and review it if circumstances change.");
        return new GdprAssessment(status, summary, findings, checklist, List.copyOf(specials));
    }
}
