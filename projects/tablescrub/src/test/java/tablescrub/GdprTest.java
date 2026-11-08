package tablescrub;

import org.junit.jupiter.api.Test;
import tablescrub.export.Format;
import tablescrub.model.Column;
import tablescrub.model.SpecialCategory;
import tablescrub.model.Table;
import tablescrub.redact.Action;
import tablescrub.redact.ColumnRule;
import tablescrub.redact.GdprAssessment;
import tablescrub.redact.GdprAssessment.Status;
import tablescrub.redact.Plan;
import tablescrub.redact.Recipient;
import tablescrub.redact.RedactedTable;
import tablescrub.redact.Redactor;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class GdprTest {
    static Table cohort() throws Exception {
        return TestUtil.load("cohort.csv", Files.readAllBytes(Path.of("samples/cohort.csv"))).getFirst();
    }

    static SpecialCategory special(Table t, String col) {
        return t.columns().get(t.headers().indexOf(col)).special();
    }

    /** Build a plan from {column -> rule}; unlisted columns are kept. */
    static Plan plan(Table t, Map<String, ColumnRule> rules, int k, boolean suppress, Recipient r) {
        List<ColumnRule> list = new ArrayList<>();
        for (Column c : t.columns()) list.add(rules.getOrDefault(c.name(), ColumnRule.KEEP));
        return new Plan(list, "s".getBytes(StandardCharsets.UTF_8), k, suppress, "", "", "", r);
    }

    static ColumnRule a(Action a) { return new ColumnRule(a, "", false, "", ""); }
    static ColumnRule qi(Action a, String p) { return new ColumnRule(a, p, true, "", ""); }

    @Test
    void detectsSpecialCategories() throws Exception {
        Table t = cohort();
        assertEquals(SpecialCategory.HEALTH, special(t, "diagnosis"));
        assertEquals(SpecialCategory.HEALTH, special(t, "systolic_bp"));
        assertEquals(SpecialCategory.HEALTH, special(t, "bmi"));
        assertEquals(SpecialCategory.HEALTH, special(t, "smoker"));
        assertEquals(SpecialCategory.NATIONAL_ID, special(t, "cpr"));
        assertNull(special(t, "sex"), "sex/gender is not an Art. 9 category");
        assertNull(special(t, "city"));
        Table o = TestUtil.loadOne("x.csv",
                "Ethnicity,Religion,TradeUnionMember,genotype_rs123,prior_conviction,sexual orientation,experimental condition,third party\n"
                        + "a,b,c,d,e,f,g,h\n");
        assertEquals(List.of(SpecialCategory.ETHNIC_ORIGIN, SpecialCategory.RELIGION, SpecialCategory.TRADE_UNION,
                        SpecialCategory.GENETIC, SpecialCategory.CRIMINAL, SpecialCategory.SEX_LIFE),
                o.columns().subList(0, 6).stream().map(Column::special).toList());
        assertNull(o.columns().get(6).special(), "'experimental condition' is not health data");
        assertNull(o.columns().get(7).special(), "'third party' is not political");
    }

    @Test
    void statusLadder() throws Exception {
        Table t = cohort();
        // 1. everything kept -> personal data
        GdprAssessment raw = Redactor.apply(t, plan(t, Map.of(), 5, false, Recipient.EEA_INSTITUTION)).gdpr();
        assertEquals(Status.PERSONAL, raw.status());
        assertTrue(raw.summary().contains("first_name"));

        // 2. direct identifiers dropped, CPR hashed -> pseudonymised
        Map<String, ColumnRule> pseudo = Map.of("first_name", a(Action.DROP), "last_name", a(Action.DROP),
                "email", a(Action.DROP), "cpr", a(Action.HASH), "record_id", a(Action.PSEUDONYM));
        GdprAssessment p = Redactor.apply(t, plan(t, pseudo, 5, false, Recipient.EEA_INSTITUTION)).gdpr();
        assertEquals(Status.PSEUDONYMISED, p.status());
        assertTrue(p.checklist().stream().anyMatch(c -> c.contains("Art. 9(2)(j)")));
        assertTrue(p.checklist().stream().anyMatch(c -> c.contains("Art. 87")));
        assertTrue(p.checklist().stream().anyMatch(c -> c.contains("Art. 28(3)")));

        // 3. all identifiers dropped but no QIs -> at risk
        Map<String, ColumnRule> dropped = new java.util.HashMap<>(Map.of("first_name", a(Action.DROP), "last_name", a(Action.DROP),
                "email", a(Action.DROP), "cpr", a(Action.DROP), "record_id", a(Action.DROP)));
        assertEquals(Status.AT_RISK, Redactor.apply(t, plan(t, dropped, 5, false, Recipient.EEA_INSTITUTION)).gdpr().status());

        // 4. QIs generalised to k >= 5 with suppression -> anonymisation candidate
        dropped.put("date_of_birth", qi(Action.GENERALIZE, "decade"));
        dropped.put("sex", qi(Action.KEEP, ""));
        dropped.put("zip", a(Action.DROP));
        dropped.put("city", a(Action.DROP));
        dropped.put("admission_date", qi(Action.GENERALIZE, "year"));
        RedactedTable anon = Redactor.apply(t, plan(t, dropped, 5, true, Recipient.PUBLIC));
        GdprAssessment g = anon.gdpr();
        assertEquals(Status.ANONYMISATION_CANDIDATE, g.status(), g.summary());
        assertTrue(g.checklist().stream().anyMatch(c -> c.contains("Recital 26")));
        assertTrue(g.checklist().stream().anyMatch(c -> c.contains("motivated-intruder")));
    }

    @Test
    void recipientChangesChecklist() throws Exception {
        Table t = cohort();
        Map<String, ColumnRule> pseudo = Map.of("first_name", a(Action.DROP), "last_name", a(Action.DROP),
                "email", a(Action.DROP), "cpr", a(Action.HASH));
        List<String> third = Redactor.apply(t, plan(t, pseudo, 5, false, Recipient.THIRD_COUNTRY)).gdpr().checklist();
        assertTrue(third.stream().anyMatch(c -> c.contains("Chapter V") && c.contains("Art. 46")));
        List<String> ai = Redactor.apply(t, plan(t, pseudo, 5, false, Recipient.AI_SERVICE)).gdpr().checklist();
        assertTrue(ai.stream().anyMatch(c -> c.contains("AI service") && c.contains("Art. 28")));
        List<String> pub = Redactor.apply(t, plan(t, pseudo, 5, false, Recipient.PUBLIC)).gdpr().checklist();
        assertTrue(pub.stream().anyMatch(c -> c.startsWith("DO NOT publish")));
    }

    @Test
    void exportsCarryGdprNotes() throws Exception {
        Table t = cohort();
        Plan p = plan(t, Map.of("first_name", a(Action.DROP), "last_name", a(Action.DROP), "email", a(Action.DROP),
                "cpr", a(Action.HASH)), 5, false, Recipient.AI_SERVICE);
        RedactedTable rt = Redactor.apply(t, p);
        ByteArrayOutputStream md = new ByteArrayOutputStream();
        Format.MARKDOWN.write(rt, md);
        String text = md.toString(StandardCharsets.UTF_8);
        assertTrue(text.contains("## GDPR notes"));
        assertTrue(text.contains("Pseudonymised personal data"));
        assertTrue(text.contains("Note for AI assistants"));
        assertTrue(text.contains("Art. 9 · health data"));
        ByteArrayOutputStream js = new ByteArrayOutputStream();
        Format.JSON.write(rt, js);
        var node = new com.fasterxml.jackson.databind.ObjectMapper().readTree(js.toByteArray());
        assertEquals("PSEUDONYMISED", node.get("provenance").get("gdpr").get("status").asText());
        assertEquals("AI_SERVICE", node.get("provenance").get("gdpr").get("recipient").asText());
        assertTrue(node.get("provenance").get("gdpr").get("dropped_columns").toString().contains("email"));
    }
}
