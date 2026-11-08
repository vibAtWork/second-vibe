package tablescrub.io;

import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellType;
import org.apache.poi.ss.usermodel.DateUtil;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.ss.usermodel.WorkbookFactory;
import tablescrub.model.RawTable;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads .xlsx/.xlsm/.xls workbooks. Each non-empty sheet becomes its own table; the first
 * non-empty row is the header. Dates become ISO-8601, numbers are written without
 * scientific notation, formulas contribute their cached value.
 */
public class ExcelReader implements TableReader {

    @Override
    public List<RawTable> read(String filename, byte[] data, ReadOptions options) throws IOException {
        List<RawTable> out = new ArrayList<>();
        String base = CsvReader.baseName(filename);
        try (Workbook wb = WorkbookFactory.create(new ByteArrayInputStream(data))) {
            String fmt = wb.getSpreadsheetVersion().name().equals("EXCEL97") ? "xls" : "xlsx";
            for (int s = 0; s < wb.getNumberOfSheets(); s++) {
                Sheet sheet = wb.getSheetAt(s);
                RawTable t = readSheet(sheet, base, fmt, options);
                if (t != null) out.add(t);
            }
        } catch (org.apache.poi.EncryptedDocumentException e) {
            throw new IOException("The workbook is password protected.", e);
        } catch (RuntimeException e) {
            throw new IOException("Could not read workbook: " + e.getMessage(), e);
        }
        if (out.isEmpty()) throw new IOException("The workbook contains no data.");
        return out;
    }

    private RawTable readSheet(Sheet sheet, String base, String fmt, ReadOptions options) {
        List<String> warnings = new ArrayList<>();
        List<String> headers = null;
        List<String[]> rows = new ArrayList<>();
        int width = 0;
        for (Row row : sheet) {
            if (headers == null) {
                List<String> cells = cells(row, Math.min(row.getLastCellNum(), options.maxColumns()));
                if (cells.stream().allMatch(c -> c == null || c.isEmpty())) continue;
                while (!cells.isEmpty() && (cells.getLast() == null || cells.getLast().isEmpty())) cells.removeLast();
                headers = cells;
                width = headers.size();
                continue;
            }
            if (rows.size() >= options.maxRows()) {
                warnings.add("Row limit reached; only the first " + options.maxRows() + " rows were loaded.");
                break;
            }
            List<String> cells = cells(row, width);
            if (cells.stream().allMatch(c -> c == null || c.isEmpty())) continue;
            rows.add(cells.toArray(new String[0]));
        }
        if (headers == null) return null;
        String name = sheet.getWorkbook().getNumberOfSheets() > 1 ? base + " / " + sheet.getSheetName() : base;
        return new RawTable(name, fmt, headers, rows, warnings);
    }

    private static List<String> cells(Row row, int width) {
        List<String> out = new ArrayList<>(Math.max(width, 0));
        for (int i = 0; i < width; i++) out.add(value(row.getCell(i)));
        return out;
    }

    static String value(Cell cell) {
        if (cell == null) return null;
        CellType type = cell.getCellType();
        if (type == CellType.FORMULA) type = cell.getCachedFormulaResultType();
        return switch (type) {
            case STRING -> cell.getStringCellValue().strip();
            case BOOLEAN -> Boolean.toString(cell.getBooleanCellValue());
            case NUMERIC -> {
                double d = cell.getNumericCellValue();
                if (DateUtil.isCellDateFormatted(cell)) {
                    LocalDateTime dt = cell.getLocalDateTimeCellValue();
                    if (dt == null) yield null;
                    yield dt.toLocalTime().toSecondOfDay() == 0 ? dt.toLocalDate().toString() : dt.toString();
                }
                yield number(d);
            }
            case ERROR -> null;
            default -> null;
        };
    }

    static String number(double d) {
        if (Double.isNaN(d) || Double.isInfinite(d)) return null;
        if (d == Math.rint(d) && Math.abs(d) < 1e15) return Long.toString((long) d);
        return new BigDecimal(Double.toString(d)).stripTrailingZeros().toPlainString();
    }
}
