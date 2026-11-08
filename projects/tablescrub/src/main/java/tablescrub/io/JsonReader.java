package tablescrub.io;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import tablescrub.model.RawTable;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Reads JSON (an array of objects, or an object holding such an array, or an array of
 * arrays with a header row) and JSON Lines. Nested objects are flattened into dotted
 * column names; nested arrays are kept as compact JSON text.
 */
public class JsonReader implements TableReader {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private final boolean lines;

    public JsonReader(boolean lines) { this.lines = lines; }

    @Override
    public List<RawTable> read(String filename, byte[] data, ReadOptions options) throws IOException {
        String text = new String(data, StandardCharsets.UTF_8);
        if (text.startsWith("﻿")) text = text.substring(1);
        List<String> warnings = new ArrayList<>();
        List<Map<String, String>> records = new ArrayList<>();
        try {
            if (lines) {
                BufferedReader br = new BufferedReader(new StringReader(text));
                String line;
                int n = 0;
                while ((line = br.readLine()) != null) {
                    n++;
                    if (line.isBlank()) continue;
                    if (records.size() >= options.maxRows()) { warnings.add(limit(options)); break; }
                    JsonNode node = MAPPER.readTree(line);
                    if (!node.isObject()) throw new IOException("Line " + n + " is not a JSON object");
                    records.add(flatten(node));
                }
            } else {
                JsonNode root = MAPPER.readTree(text);
                JsonNode array = findArray(root);
                if (array == null) throw new IOException("Expected a JSON array of objects (or an object containing one).");
                if (array.size() > 0 && array.get(0).isArray()) return List.of(fromArrayOfArrays(filename, array, options));
                for (JsonNode el : array) {
                    if (records.size() >= options.maxRows()) { warnings.add(limit(options)); break; }
                    if (el.isObject()) records.add(flatten(el));
                    else {
                        Map<String, String> m = new LinkedHashMap<>();
                        m.put("value", scalar(el));
                        records.add(m);
                    }
                }
            }
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) {
            throw new IOException("Invalid JSON: " + e.getOriginalMessage(), e);
        }
        LinkedHashMap<String, Integer> keys = new LinkedHashMap<>();
        for (Map<String, String> r : records) for (String k : r.keySet()) keys.putIfAbsent(k, keys.size());
        if (keys.size() > options.maxColumns()) throw new IOException("Too many columns (" + keys.size() + ")");
        List<String[]> rows = new ArrayList<>(records.size());
        for (Map<String, String> r : records) {
            String[] row = new String[keys.size()];
            r.forEach((k, v) -> row[keys.get(k)] = v);
            rows.add(row);
        }
        return List.of(new RawTable(CsvReader.baseName(filename), lines ? "jsonl" : "json",
                new ArrayList<>(keys.keySet()), rows, warnings));
    }

    private RawTable fromArrayOfArrays(String filename, JsonNode array, ReadOptions options) {
        List<String> headers = new ArrayList<>();
        array.get(0).forEach(h -> headers.add(scalar(h)));
        List<String[]> rows = new ArrayList<>();
        List<String> warnings = new ArrayList<>();
        for (int i = 1; i < array.size(); i++) {
            if (rows.size() >= options.maxRows()) { warnings.add(limit(options)); break; }
            JsonNode r = array.get(i);
            String[] row = new String[r.size()];
            for (int j = 0; j < r.size(); j++) row[j] = scalar(r.get(j));
            rows.add(row);
        }
        return new RawTable(CsvReader.baseName(filename), "json", headers, rows, warnings);
    }

    private static String limit(ReadOptions o) {
        return "Row limit reached; only the first " + o.maxRows() + " rows were loaded.";
    }

    private static JsonNode findArray(JsonNode root) {
        if (root.isArray()) return root;
        if (root.isObject()) {
            for (Iterator<JsonNode> it = root.elements(); it.hasNext(); ) {
                JsonNode child = it.next();
                if (child.isArray() && child.size() > 0 && (child.get(0).isObject() || child.get(0).isArray())) return child;
            }
            return MAPPER.createArrayNode().add(root);
        }
        return null;
    }

    static Map<String, String> flatten(JsonNode node) {
        Map<String, String> out = new LinkedHashMap<>();
        flatten("", node, out);
        return out;
    }

    private static void flatten(String prefix, JsonNode node, Map<String, String> out) {
        if (node instanceof ObjectNode obj && (prefix.isEmpty() || obj.size() > 0)) {
            obj.fields().forEachRemaining(e ->
                    flatten(prefix.isEmpty() ? e.getKey() : prefix + "." + e.getKey(), e.getValue(), out));
        } else {
            out.put(prefix, scalar(node));
        }
    }

    private static String scalar(JsonNode n) {
        if (n == null || n.isNull() || n.isMissingNode()) return null;
        if (n.isTextual()) return n.textValue();
        if (n.isContainerNode()) return n.toString();
        if (n.isNumber() && n.isFloatingPointNumber()) return n.decimalValue().stripTrailingZeros().toPlainString();
        return n.asText();
    }
}
