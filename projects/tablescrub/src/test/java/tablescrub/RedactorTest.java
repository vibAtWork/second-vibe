package tablescrub;

import org.junit.jupiter.api.Test;
import tablescrub.model.Table;
import tablescrub.redact.Action;
import tablescrub.redact.ColumnRule;
import tablescrub.redact.Plan;
import tablescrub.redact.RedactedTable;
import tablescrub.redact.Redactor;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class RedactorTest {
    static final String CSV = """
            id,name,dob,age,zip,dx,bp
            A1,Anna,1985-04-03,39,2100,flu,120.4
            A2,Bo,1985-11-30,38,2150,flu,131.6
            A1,Anna,1985-04-03,39,2100,cold,118
            A3,Cy,1990-01-01,34,8000,rare thing,140
            A4,Di,1991-06-06,33,8000,flu,
            """;

    static Plan plan(Table t, ColumnRule... rules) {
        List<ColumnRule> list = new ArrayList<>(Arrays.asList(rules));
        while (list.size() < t.columnCount()) list.add(ColumnRule.KEEP);
        return new Plan(list, "secret".getBytes(StandardCharsets.UTF_8), 2, false, "", "", "");
    }

    static ColumnRule r(Action a, String p) { return new ColumnRule(a, p, false, "", ""); }
    static ColumnRule qi(Action a, String p) { return new ColumnRule(a, p, true, "", ""); }

    static List<String> col(RedactedTable rt, String name) {
        int i = rt.headers().indexOf(name);
        return rt.rows().stream().map(r -> r[i]).toList();
    }

    @Test
    void dropMaskHashPseudonym() throws Exception {
        Table t = TestUtil.loadOne("p.csv", CSV);
        RedactedTable rt = Redactor.apply(t, plan(t, r(Action.PSEUDONYM, "P"), r(Action.DROP, ""),
                r(Action.MASK, ""), r(Action.HASH, "12")));
        assertFalse(rt.headers().contains("name"));
        assertEquals(List.of("P0001", "P0002", "P0001", "P0003", "P0004"), col(rt, "id"));
        assertTrue(col(rt, "dob").stream().allMatch("[REDACTED]"::equals));
        List<String> h = col(rt, "age");
        assertEquals(12, h.getFirst().length());
        assertEquals(h.get(0), h.get(2), "same input, same hash");
        assertNotEquals(h.get(0), h.get(1));
        // a different secret gives different hashes
        Plan other = new Plan(plan(t, r(Action.KEEP, ""), r(Action.KEEP, ""), r(Action.KEEP, ""), r(Action.HASH, "12")).rules(),
                "other".getBytes(StandardCharsets.UTF_8), 2, false, "", "", "");
        assertNotEquals(h.getFirst(), col(Redactor.apply(t, other), "age").getFirst());
        assertTrue(rt.log().stream().anyMatch(l -> l.contains("HMAC")));
    }

    @Test
    void generalizeByType() throws Exception {
        Table t = TestUtil.loadOne("p.csv", CSV);
        RedactedTable rt = Redactor.apply(t, plan(t, r(Action.GENERALIZE, "1"), r(Action.KEEP, ""),
                r(Action.GENERALIZE, "month"), r(Action.GENERALIZE, "10"), r(Action.GENERALIZE, "100"),
                r(Action.KEEP, ""), r(Action.GENERALIZE, "10")));
        assertEquals("A*", col(rt, "id").getFirst());
        assertEquals("1985-04", col(rt, "dob").getFirst());
        assertEquals("30-39", col(rt, "age").getFirst());
        assertEquals("2100-2199", col(rt, "zip").getFirst());
        assertEquals("[120, 130)", col(rt, "bp").getFirst());
        assertNull(col(rt, "bp").get(4));
        RedactedTable years = Redactor.apply(t, plan(t, r(Action.KEEP, ""), r(Action.KEEP, ""), r(Action.GENERALIZE, "")));
        assertEquals("1985", col(years, "dob").getFirst());
    }

    @Test
    void suppressRareAndRound() throws Exception {
        Table t = TestUtil.loadOne("p.csv", CSV);
        RedactedTable rt = Redactor.apply(t, plan(t, r(Action.KEEP, ""), r(Action.KEEP, ""), r(Action.KEEP, ""),
                r(Action.KEEP, ""), r(Action.KEEP, ""), r(Action.SUPPRESS_RARE, "2"), r(Action.ROUND, "-1")));
        assertEquals(List.of("flu", "flu", Redactor.RARE, Redactor.RARE, "flu"), col(rt, "dx"));
        assertEquals("120", col(rt, "bp").get(0));
        assertEquals("130", col(rt, "bp").get(1));
    }

    @Test
    void kAnonymityAndRowSuppression() throws Exception {
        Table t = TestUtil.loadOne("p.csv", CSV);
        RedactedTable rt = Redactor.apply(t, plan(t, r(Action.KEEP, ""), r(Action.DROP, ""), r(Action.DROP, ""),
                qi(Action.GENERALIZE, "10"), qi(Action.GENERALIZE, "1000")));
        // groups: (30-39, 2000-2999) x3, (30-39, 8000-8999) x2  -> k = 2
        assertEquals(2, rt.kStats().k());
        assertEquals(2, rt.kStats().classes());
        assertTrue(rt.kStats().ok());

        Plan strict = new Plan(plan(t, r(Action.KEEP, ""), r(Action.DROP, ""), r(Action.DROP, ""),
                qi(Action.GENERALIZE, "10"), qi(Action.GENERALIZE, "1000")).rules(),
                new byte[]{1}, 3, true, "", "", "");
        RedactedTable s = Redactor.apply(t, strict);
        assertEquals(2, s.kStats().rowsSuppressed());
        assertEquals(3, s.rows().size());
        assertEquals(3, s.kStats().k());
        assertEquals(3, s.columns().getFirst().nonNull(), "column stats reflect suppressed output");
    }

    @Test
    void previewLimitDoesNotChangeStatistics() throws Exception {
        Table t = TestUtil.loadOne("p.csv", CSV);
        Plan p = plan(t, r(Action.KEEP, ""), r(Action.KEEP, ""), r(Action.KEEP, ""), qi(Action.KEEP, ""));
        RedactedTable full = Redactor.apply(t, p), preview = Redactor.apply(t, p, 2);
        assertEquals(2, preview.rows().size());
        assertEquals(full.kStats().k(), preview.kStats().k());
    }

    @Test
    void renamesAreDeduplicated() throws Exception {
        Table t = TestUtil.loadOne("p.csv", CSV);
        RedactedTable rt = Redactor.apply(t, plan(t, new ColumnRule(Action.KEEP, "", false, "", "x"),
                new ColumnRule(Action.KEEP, "", false, "", "x")));
        assertEquals("x", rt.headers().get(0));
        assertEquals("x_2", rt.headers().get(1));
    }
}
