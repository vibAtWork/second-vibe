package tablescrub.io;

import tablescrub.model.RawTable;

import java.io.IOException;
import java.util.List;

/** Converts the bytes of one uploaded file into one or more raw tables. */
public interface TableReader {
    List<RawTable> read(String filename, byte[] data, ReadOptions options) throws IOException;
}
