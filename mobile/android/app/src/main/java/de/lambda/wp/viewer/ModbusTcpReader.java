package de.lambda.wp.viewer;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

final class ModbusTcpReader {
    record Block(int address, int count) {}
    record Result(int[] data, String error) {}

    static List<Result> read(String host, int port, int unit, int timeout, List<Block> blocks)
            throws IOException {
        List<Result> results = new ArrayList<>();
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress(host, port), timeout);
            socket.setTcpNoDelay(true);
            for (int index = 0; index < blocks.size(); index++) {
                Block block = blocks.get(index);
                int transaction = index + 1;
                long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeout);
                byte[] request = {
                    (byte) (transaction >> 8), (byte) transaction, 0, 0, 0, 6, (byte) unit, 3,
                    (byte) (block.address() >> 8), (byte) block.address(),
                    (byte) (block.count() >> 8), (byte) block.count()
                };
                socket.getOutputStream().write(request);
                byte[] header = readExact(socket, 7, deadline);
                int length = word(header, 4);
                if (word(header, 0) != transaction || word(header, 2) != 0
                        || (header[6] & 255) != unit || length < 3 || length > 253) {
                    throw new IOException("Invalid Modbus MBAP response");
                }
                byte[] pdu = readExact(socket, length - 1, deadline);
                if ((pdu[0] & 255) == 0x83 && pdu.length == 2) {
                    results.add(new Result(null, "Modbus exception " + (pdu[1] & 255)));
                    continue;
                }
                if (pdu[0] != 3 || pdu.length != 2 + block.count() * 2
                        || (pdu[1] & 255) != block.count() * 2) {
                    throw new IOException("Invalid Modbus function or register byte count");
                }
                int[] data = new int[block.count()];
                for (int i = 0; i < data.length; i++) {
                    data[i] = word(pdu, 2 + i * 2);
                }
                results.add(new Result(data, null));
            }
        }
        return results;
    }

    private static int word(byte[] bytes, int offset) {
        return ((bytes[offset] & 255) << 8) | (bytes[offset + 1] & 255);
    }

    private static byte[] readExact(Socket socket, int count, long deadline) throws IOException {
        byte[] bytes = new byte[count];
        InputStream input = socket.getInputStream();
        int offset = 0;
        while (offset < count) {
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) throw new SocketTimeoutException("Modbus response timed out");
            socket.setSoTimeout((int) Math.max(1, TimeUnit.NANOSECONDS.toMillis(remaining)));
            int received = input.read(bytes, offset, count - offset);
            if (received < 0) throw new IOException("Modbus connection closed before complete response");
            offset += received;
        }
        return bytes;
    }
}
