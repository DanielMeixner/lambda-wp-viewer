package de.lambda.wp.viewer;

import java.io.DataInputStream;
import java.io.IOException;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/** Standalone TCP regression test; no Android device or third-party test runner is needed. */
public class ModbusTcpReaderTest {
    private interface Peer { void run(Socket socket) throws Exception; }
    private interface Client { void run(int port) throws Exception; }

    public static void main(String[] args) throws Exception {
        exchange(socket -> {
            DataInputStream input = new DataInputStream(socket.getInputStream());
            byte[] marker = input.readNBytes(12);
            check(Arrays.equals(marker, new byte[] {0, 1, 0, 0, 0, 6, 1, 3, 39, 14, 0, 2}), "FC03 marker request");
            byte[] response = {0, 1, 0, 0, 0, 7, 1, 3, 4, 0, 1, (byte) 255, (byte) 255};
            for (byte value : response) {
                socket.getOutputStream().write(value);
                socket.getOutputStream().flush();
            }
            byte[] exception = input.readNBytes(12);
            check(exception[1] == 2 && exception[7] == 3, "Sequential transaction");
            socket.getOutputStream().write(new byte[] {0, 2, 0, 0, 0, 3, 1, (byte) 0x83, 2});
            byte[] next = input.readNBytes(12);
            check(next[1] == 3, "Continue after Modbus exception");
            socket.getOutputStream().write(new byte[] {0, 3, 0, 0, 0, 5, 1, 3, 2, (byte) 128, 0});
            check(input.read() == -1, "Connection closes on success");
        }, port -> {
            var results = ModbusTcpReader.read("127.0.0.1", port, 1, 1000, List.of(
                new ModbusTcpReader.Block(9998, 2),
                new ModbusTcpReader.Block(0, 1),
                new ModbusTcpReader.Block(1, 1)));
            check(Arrays.equals(results.get(0).data(), new int[] {1, 65535}), "Unsigned registers");
            check(results.get(1).error().equals("Modbus exception 2"), "Per-block exception");
            check(Arrays.equals(results.get(2).data(), new int[] {32768}), "Later block succeeds");
        });
        byte[] valid = {0, 1, 0, 0, 0, 5, 1, 3, 2, 0, 42};
        int[][] corruptions = {
            {1, 9}, {3, 1}, {6, 2}, {5, 2}, {5, 254}, {7, 4}, {8, 4}, {7, 0x83}
        };
        for (int[] mutation : corruptions) {
            byte[] response = valid.clone();
            response[mutation[0]] = (byte) mutation[1];
            exchange(socket -> {
                socket.getInputStream().readNBytes(12);
                socket.getOutputStream().write(response);
                check(socket.getInputStream().read() == -1, "Connection closes on malformed response");
            }, port -> expectFailure(port, 1000));
        }
        exchange(socket -> {
            socket.getInputStream().readNBytes(12);
            socket.getOutputStream().write(new byte[] {0, 1, 0});
            socket.shutdownOutput();
        }, port -> expectFailure(port, 1000));
        exchange(socket -> {
            socket.getInputStream().readNBytes(12);
            check(socket.getInputStream().read() == -1, "Timeout closes connection");
        }, port -> expectFailure(port, 250));
        System.out.println("Native Modbus TCP: 11 integration scenarios passed");
    }

    private static void expectFailure(int port, int timeout) throws Exception {
        try {
            ModbusTcpReader.read("127.0.0.1", port, 1, timeout,
                List.of(new ModbusTcpReader.Block(9998, 1)));
            throw new AssertionError("Malformed/absent response must fail");
        } catch (IOException expected) {
            check(expected.getMessage() != null, "Useful error message");
        }
    }

    private static void exchange(Peer peer, Client client) throws Exception {
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try (ServerSocket server = new ServerSocket(0)) {
            server.setSoTimeout(3000);
            Future<?> future = executor.submit(() -> {
                try (Socket socket = server.accept()) {
                    socket.setSoTimeout(3000);
                    peer.run(socket);
                } catch (Exception error) {
                    throw new RuntimeException(error);
                }
            });
            client.run(server.getLocalPort());
            future.get(5, TimeUnit.SECONDS);
        } finally {
            executor.shutdownNow();
        }
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
