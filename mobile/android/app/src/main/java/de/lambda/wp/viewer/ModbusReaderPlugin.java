package de.lambda.wp.viewer;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(name = "ModbusReader")
public class ModbusReaderPlugin extends Plugin {
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void read(PluginCall call) {
        try {
            String host = call.getString("host", "").trim();
            if (host.isEmpty() || host.length() > 253 || host.matches(".*[\\s/\\\\].*")) {
                throw new IllegalArgumentException("Invalid host");
            }
            int port = integer(call.getData(), "port", 502, 1, 65535);
            int unit = integer(call.getData(), "unitId", 1, 0, 255);
            int timeout = integer(call.getData(), "timeoutMs", 3000, 200, 30000);
            JSONArray input = call.getArray("blocks");
            if (input == null || input.length() < 1 || input.length() > 64) {
                throw new IllegalArgumentException("blocks must contain 1 to 64 reads");
            }
            List<ModbusTcpReader.Block> blocks = new ArrayList<>();
            for (int i = 0; i < input.length(); i++) {
                JSONObject block = input.getJSONObject(i);
                int address = integer(block, "address", -1, 0, 65535);
                int count = integer(block, "count", -1, 1, 125);
                if (address + count > 65536) throw new IllegalArgumentException("Register range overflows");
                blocks.add(new ModbusTcpReader.Block(address, count));
            }
            executor.execute(() -> {
                try {
                    JSArray results = new JSArray();
                    for (ModbusTcpReader.Result result : ModbusTcpReader.read(host, port, unit, timeout, blocks)) {
                        JSObject entry = new JSObject();
                        if (result.error() != null) {
                            entry.put("error", result.error());
                        } else {
                            JSArray data = new JSArray();
                            for (int value : result.data()) data.put(value);
                            entry.put("data", data);
                        }
                        results.put(entry);
                    }
                    call.resolve(new JSObject().put("results", results));
                } catch (Exception error) {
                    call.reject("Modbus read failed: " + error.getMessage(), error);
                }
            });
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    private static int integer(JSONObject object, String key, int fallback, int min, int max) {
        Object value = object.opt(key);
        double number = value == null ? fallback : value instanceof Number ? ((Number) value).doubleValue() : Double.NaN;
        if (!Double.isFinite(number) || number != Math.rint(number) || number < min || number > max) {
            throw new IllegalArgumentException("Invalid " + key);
        }
        return (int) number;
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
    }
}
