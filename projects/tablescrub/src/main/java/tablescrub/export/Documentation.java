package tablescrub.export;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import tablescrub.redact.Action;
import tablescrub.redact.GdprAssessment;
import tablescrub.redact.RedactedTable;
import tablescrub.redact.RedactedTable.KStats;
import tablescrub.redact.RedactedTable.OutColumn;

import java.text.Normalizer;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** Human- and machine-readable documentation shared by all formats. */
public final class Documentation {
    private static final JsonNodeFactory NF = JsonNodeFactory.instance;

    private Documentation() {}

    public static String slug(String s) {
        String n = Normalizer.normalize(s == null ? "" : s, Normalizer.Form.NFD).replaceAll("\\p{M}", "");
        n = n.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]+", "-").replaceAll("^-+|-+$", "");
        return n.isEmpty() ? "dataset" : n.length() > 60 ? n.substring(0, 60) : n;
    }

    static String now() {
        return OffsetDateTime.now(ZoneOffset.UTC).truncatedTo(ChronoUnit.SECONDS).toString();
    }

    public static String treatment(OutColumn c) {
        String p = c.param() == null || c.param().isBlank() ? "" : " (" + c.param() + ")";
        return c.action() == Action.KEEP ? "unchanged" : c.action().label.toLowerCase(Locale.ROOT) + p;
    }

    static List<String[]> provenancePairs(RedactedTable t) {
        List<String[]> out = new ArrayList<>();
        out.add(new String[]{"title", t.name()});
        if (notBlank(t.plan().description())) out.add(new String[]{"description", t.plan().description().strip()});
        if (notBlank(t.plan().license())) out.add(new String[]{"license / terms", t.plan().license().strip()});
        out.add(new String[]{"source table", t.sourceName() + " (" + t.sourceFormat() + ")"});
        out.add(new String[]{"rows", t.rows().size() + " of " + t.sourceRows() + " source rows"});
        out.add(new String[]{"columns", String.valueOf(t.columns().size())});
        out.add(new String[]{"exported", now()});
        KStats k = t.kStats();
        if (k.enabled())
            out.add(new String[]{"k-anonymity", "k = " + k.k() + " over [" + String.join(", ", k.quasiIdentifiers())
                    + "], target k >= " + k.threshold()});
        GdprAssessment g = t.gdpr();
        out.add(new String[]{"GDPR status (self-assessed)", g.status().label});
        out.add(new String[]{"intended recipient", t.plan().recipient().label});
        out.add(new String[]{"tool", "tablescrub 0.1.0"});
        return out;
    }

    static ObjectNode provenance(RedactedTable t) {
        ObjectNode o = NF.objectNode();
        for (String[] kv : provenancePairs(t)) o.put(kv[0], kv[1]);
        ArrayNode log = o.putArray("redaction_log");
        t.log().forEach(log::add);
        o.set("gdpr", gdprNode(t));
        return o;
    }

    static ObjectNode gdprNode(RedactedTable t) {
        GdprAssessment g = t.gdpr();
        ObjectNode n = NF.objectNode();
        n.put("status", g.status().name());
        n.put("status_label", g.status().label);
        n.put("summary", g.summary());
        n.put("recipient", t.plan().recipient().name());
        ArrayNode sp = n.putArray("special_categories");
        g.specials().forEach(x -> sp.add(x.tag()));
        ArrayNode f = n.putArray("findings");
        g.findings().forEach(f::add);
        ArrayNode c = n.putArray("checklist");
        g.checklist().forEach(c::add);
        ArrayNode d = n.putArray("dropped_columns");
        t.dropped().forEach(x -> d.add(x.name()));
        n.put("regulation", GdprAssessment.REGULATION_URL);
        n.put("disclaimer", GdprAssessment.DISCLAIMER);
        return n;
    }

    /** Frictionless Table Schema. */
    static ObjectNode tableSchema(RedactedTable t) {
        ObjectNode schema = NF.objectNode();
        ArrayNode fields = schema.putArray("fields");
        for (OutColumn c : t.columns()) {
            ObjectNode f = fields.addObject();
            f.put("name", c.name());
            f.put("type", c.type().frictionless());
            String desc = c.description().isBlank() ? "" : c.description().strip();
            if (c.action() != Action.KEEP) desc = (desc.isEmpty() ? "" : desc + " ") + "[" + treatment(c) + "]";
            if (!desc.isEmpty()) f.put("description", desc);
            if (!c.originalName().equals(c.name())) f.put("x-original-name", c.originalName());
            if (c.special() != null && c.action() != Action.MASK) f.put("x-gdpr-category", c.special().tag());
        }
        schema.putArray("missingValues").add("");
        return schema;
    }

    static ObjectNode dataPackage(RedactedTable t) {
        ObjectNode p = NF.objectNode();
        p.put("profile", "tabular-data-package");
        p.put("name", slug(t.name()));
        p.put("title", t.name());
        if (notBlank(t.plan().description())) p.put("description", t.plan().description().strip());
        if (notBlank(t.plan().license())) p.putArray("licenses").addObject().put("title", t.plan().license().strip());
        p.put("created", now());
        p.putArray("sources").addObject().put("title", t.sourceName() + " (" + t.sourceFormat() + ")");
        ObjectNode res = p.putArray("resources").addObject();
        res.put("name", slug(t.name()));
        res.put("path", "data.csv");
        res.put("profile", "tabular-data-resource");
        res.put("format", "csv");
        res.put("mediatype", "text/csv");
        res.put("encoding", "utf-8");
        res.set("schema", tableSchema(t));
        ObjectNode red = p.putObject("x-redaction");
        ArrayNode log = red.putArray("log");
        t.log().forEach(log::add);
        KStats k = t.kStats();
        if (k.enabled()) {
            ObjectNode ko = red.putObject("k_anonymity");
            ArrayNode qi = ko.putArray("quasi_identifiers");
            k.quasiIdentifiers().forEach(qi::add);
            ko.put("k", k.k());
            ko.put("target", k.threshold());
            ko.put("rows_suppressed", k.rowsSuppressed());
        }
        p.set("x-gdpr", gdprNode(t));
        return p;
    }

    /** README / LLM context block. */
    public static String readme(RedactedTable t, boolean forPackage) {
        StringBuilder sb = new StringBuilder();
        sb.append("# ").append(t.name()).append("\n\n");
        if (notBlank(t.plan().description())) sb.append(t.plan().description().strip()).append("\n\n");
        if (!forPackage) {
            sb.append("> This document describes a de-identified tabular dataset. The data dictionary explains each column ")
              .append("and how it was transformed; transformed values (hashes, pseudonyms, bins, [RARE], [REDACTED]) ")
              .append("are intentional and cannot be reversed from this file.\n\n");
        }
        sb.append("## Provenance\n\n");
        for (String[] kv : provenancePairs(t)) sb.append("- **").append(kv[0]).append("**: ").append(md(kv[1])).append("\n");
        sb.append("\n## Data dictionary\n\n| Column | Type | Description | Treatment | GDPR category | Non-empty | Distinct |\n|---|---|---|---|---|---|---|\n");
        for (OutColumn c : t.columns()) {
            sb.append("| ").append(md(c.name())).append(" | ").append(c.type().frictionless()).append(" | ")
              .append(md(c.description())).append(" | ").append(md(treatment(c))).append(" | ")
              .append(c.special() == null ? "" : c.special().tag()).append(" | ")
              .append(c.nonNull()).append(" | ").append(c.distinct()).append(" |\n");
        }
        if (!t.log().isEmpty()) {
            sb.append("\n## Redaction log\n\n");
            for (String l : t.log()) sb.append("- ").append(md(l)).append("\n");
        }
        sb.append(gdprMarkdown(t, !forPackage));
        if (forPackage) {
            sb.append("\n## Files\n\n- `data.csv`: the data (UTF-8, RFC 4180, empty field = missing)\n")
              .append("- `datapackage.json`: machine-readable metadata ([Frictionless Data Package](https://specs.frictionlessdata.io/data-package/))\n");
        }
        return sb.toString();
    }

    /** GDPR section. For AI recipients it is phrased so the assistant also knows how to treat the data. */
    static String gdprMarkdown(RedactedTable t, boolean forAi) {
        GdprAssessment g = t.gdpr();
        StringBuilder sb = new StringBuilder("\n## GDPR notes\n\n");
        sb.append("- **Status (self-assessed)**: ").append(g.status().label).append(". ").append(md(g.summary())).append("\n");
        sb.append("- **Intended recipient**: ").append(t.plan().recipient().label).append("\n");
        if (!g.specials().isEmpty())
            sb.append("- **Special categories present**: ").append(String.join("; ", g.specials().stream().map(x -> x.tag()).toList())).append("\n");
        for (String f : g.findings()) sb.append("- ").append(md(f)).append("\n");
        if (forAi && g.status() != GdprAssessment.Status.ANONYMISATION_CANDIDATE) {
            sb.append("\n**Note for AI assistants:** this extract is still personal data under the GDPR. Do not try to re-identify ")
              .append("individuals, link the data with other sources, or reproduce individual-level records beyond what the analysis needs. ")
              .append("Prefer aggregate results.\n");
        }
        if (!forAi && !g.checklist().isEmpty()) {
            sb.append("\n### Sender checklist (completed before sharing)\n\n");
            for (String c : g.checklist()) sb.append("- [ ] ").append(md(c)).append("\n");
        }
        sb.append("\n_").append(GdprAssessment.DISCLAIMER).append(" Regulation (EU) 2016/679: ").append(GdprAssessment.REGULATION_URL).append("_\n");
        return sb.toString();
    }

    private static String md(String s) {
        return s == null ? "" : s.replace("|", "\\|").replace("\n", " ");
    }

    private static boolean notBlank(String s) { return s != null && !s.isBlank(); }
}
