package tablescrub.io;

import tablescrub.model.PiiHint;
import tablescrub.model.SpecialCategory;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Header-based detection of GDPR special-category data (Art. 9), criminal-offence data (Art. 10)
 * and national identifiers (Art. 87). Heuristic. "Data concerning health" is broad: diagnoses and
 * medication, but also measurements such as blood pressure, BMI or HbA1c.
 */
public final class SpecialCategories {
    private SpecialCategories() {}

    private static final Map<SpecialCategory, Set<String>> RULES = new LinkedHashMap<>();

    static {
        RULES.put(SpecialCategory.GENETIC, Set.of("genotype", "genetic", "snp", "allele", "dna", "haplotype",
                "mutation", "gene variant", "variant call", "rsid", "brca", "brca1", "brca2", "exome", "genome"));
        RULES.put(SpecialCategory.BIOMETRIC, Set.of("biometric", "fingerprint", "face template", "facial", "iris",
                "retina", "voiceprint", "face image", "palm print"));
        RULES.put(SpecialCategory.HEALTH, Set.of("diagnosis", "diagnoses", "diagnose", "dx", "icd", "icd10", "icd 10",
                "icd11", "disease", "illness", "comorbidity", "comorbidities", "medication", "medicine",
                "drug", "prescription", "atc", "treatment", "therapy", "surgery", "symptom", "symptoms",
                "hiv", "cancer", "tumour", "tumor", "pregnancy", "pregnant", "disability", "psychiatric", "mental health",
                "depression", "blood type", "allergy", "allergies", "vaccination", "vaccine", "bmi", "blood pressure",
                "systolic", "diastolic", "bp", "hba1c", "glucose", "cholesterol", "ldl", "hdl", "creatinine", "egfr",
                "heart rate", "pulse", "smoker", "smoking", "alcohol", "lab result", "sygdom", "diagnosekode",
                "behandling", "medicin", "rygning", "rygestatus", "admission", "discharge", "hospital",
                "patient status", "cause of death", "dodsarsag"));
        RULES.put(SpecialCategory.ETHNIC_ORIGIN, Set.of("ethnicity", "ethnic", "race", "racial", "ethnic group",
                "etnicitet", "herkomst", "ancestry"));
        RULES.put(SpecialCategory.POLITICAL, Set.of("political", "politics", "political party", "party affiliation", "vote",
                "voted", "voting", "parti"));
        RULES.put(SpecialCategory.RELIGION, Set.of("religion", "religious", "faith", "belief", "beliefs",
                "denomination", "religion affiliation", "trosretning"));
        RULES.put(SpecialCategory.TRADE_UNION, Set.of("trade union", "union member", "union membership", "fagforening"));
        RULES.put(SpecialCategory.SEX_LIFE, Set.of("sexual orientation", "sexuality", "sex life", "lgbt", "lgbtq",
                "seksualitet"));
        RULES.put(SpecialCategory.CRIMINAL, Set.of("conviction", "convictions", "criminal", "criminal record",
                "offence", "offense", "offences", "crime", "arrest", "arrested", "prison", "incarceration",
                "straffeattest"));
    }

    public static SpecialCategory detect(String header, PiiHint hint) {
        if ("national id".equals(hint.category())) return SpecialCategory.NATIONAL_ID;
        List<String> tokens = PiiDetector.tokens(header);
        for (var e : RULES.entrySet()) {
            for (String phrase : e.getValue()) {
                String[] p = phrase.split(" ");
                for (int i = 0; i + p.length <= tokens.size(); i++) {
                    boolean match = true;
                    for (int j = 0; j < p.length && match; j++) match = tokens.get(i + j).equals(p[j]);
                    if (match) return e.getKey();
                }
            }
        }
        if ("ethnicity".equals(hint.category())) return SpecialCategory.ETHNIC_ORIGIN;
        return null;
    }
}
