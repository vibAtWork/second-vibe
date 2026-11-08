package tablescrub;

import org.junit.jupiter.api.Test;
import tablescrub.model.Column;
import tablescrub.model.PiiHint.Level;
import tablescrub.model.Table;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class PiiDetectorTest {
    private static Column col(Table t, String name) {
        return t.columns().get(t.headers().indexOf(name));
    }

    @Test
    void sampleCohortIsFlaggedSensibly() throws Exception {
        Table t = TestUtil.load("cohort.csv", Files.readAllBytes(Path.of("samples/cohort.csv"))).getFirst();
        assertEquals("person name", col(t, "first_name").pii().category());
        assertEquals("person name", col(t, "last_name").pii().category());
        assertEquals("national id", col(t, "cpr").pii().category());
        assertEquals("HASH", col(t, "cpr").pii().suggestion());
        assertEquals("email", col(t, "email").pii().category());
        assertEquals(Level.QUASI, col(t, "date_of_birth").pii().level());
        assertEquals(Level.QUASI, col(t, "zip").pii().level());
        assertEquals(Level.QUASI, col(t, "sex").pii().level());
        assertEquals("event date", col(t, "admission_date").pii().category());
        assertFalse(col(t, "diagnosis").pii().flagged());
        assertFalse(col(t, "systolic_bp").pii().flagged());
        assertFalse(col(t, "bmi").pii().flagged());
    }

    @Test
    void valuePatternsWinOverBlandHeaders() throws Exception {
        Table t = TestUtil.loadOne("x.csv", """
                contact,ref,host,tlfnr
                a@b.dk,010203-1234,10.0.0.1,+45 12 34 56 78
                c@d.org,311299-4321,192.168.1.20,+45 87 65 43 21
                """);
        assertEquals("email", col(t, "contact").pii().category());
        assertEquals("national id", col(t, "ref").pii().category());
        assertEquals("ip address", col(t, "host").pii().category());
        assertEquals("phone", col(t, "tlfnr").pii().category());
    }

    @Test
    void avoidsCommonFalsePositives() throws Exception {
        Table t = TestUtil.loadOne("x.csv", """
                gene name,cell type,created by,page,sample count
                BRCA1,T cell,lab A,1,4
                TP53,B cell,lab B,2,5
                """);
        for (Column c : t.columns()) assertFalse(c.pii().flagged(), c.name() + " should not be flagged");
    }

    @Test
    void multilingualHeaders() throws Exception {
        Table t = TestUtil.loadOne("x.csv", "Fornavn,Fødselsdato,Postnummer,PatientFirstName\nAnna,1990-01-01,2100,Bo\n");
        assertEquals("person name", col(t, "Fornavn").pii().category());
        assertEquals("birth date", col(t, "Fødselsdato").pii().category());
        assertEquals("postal code", col(t, "Postnummer").pii().category());
        assertEquals("person name", col(t, "PatientFirstName").pii().category());
    }
}
