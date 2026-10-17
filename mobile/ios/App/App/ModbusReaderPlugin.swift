import Capacitor
import Foundation
import Network
import CoreFoundation

@objc(ModbusReaderPlugin)
public class ModbusReaderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ModbusReaderPlugin"
    public let jsName = "ModbusReader"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise)
    ]

    @objc func read(_ call: CAPPluginCall) {
        do {
            let host = (call.getString("host") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !host.isEmpty, host.count <= 253,
                  host.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
                  !host.contains("/"), !host.contains("\\") else {
                throw ReadError.invalid("Invalid host")
            }
            let port = try integer(call.options["port"], fallback: 502, min: 1, max: 65535)
            let unit = try integer(call.options["unitId"], fallback: 1, min: 0, max: 255)
            let timeout = try integer(call.options["timeoutMs"], fallback: 3000, min: 200, max: 30000)
            guard let input = call.options["blocks"] as? [[String: Any]],
                  (1...64).contains(input.count) else {
                throw ReadError.invalid("blocks must contain 1 to 64 reads")
            }
            let blocks = try input.map { block -> ReadBlock in
                let address = try integer(block["address"], fallback: -1, min: 0, max: 65535)
                let count = try integer(block["count"], fallback: -1, min: 1, max: 125)
                guard address + count <= 65536 else { throw ReadError.invalid("Register range overflows") }
                return ReadBlock(address: address, count: count)
            }
            let session = ReadSession(host: host, port: port, unit: unit, timeout: timeout, blocks: blocks, call: call)
            session.start()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    private func integer(_ value: Any?, fallback: Int, min: Int, max: Int) throws -> Int {
        guard let value = value else {
            guard (min...max).contains(fallback) else { throw ReadError.invalid("Missing register range") }
            return fallback
        }
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else {
            throw ReadError.invalid("Expected an integer")
        }
        let numeric = number.doubleValue
        guard numeric.isFinite, numeric.rounded() == numeric, numeric >= Double(min), numeric <= Double(max) else {
            throw ReadError.invalid("Integer outside allowed range")
        }
        return Int(numeric)
    }
}

private enum ReadError: LocalizedError {
    case invalid(String)
    var errorDescription: String? {
        switch self { case .invalid(let message): return message }
    }
}

private struct ReadBlock {
    let address: Int
    let count: Int
}

private final class ReadSession {
    private let connection: NWConnection
    private let queue = DispatchQueue(label: "de.lambda.wp.viewer.modbus")
    private let unit: Int
    private let timeout: Int
    private let blocks: [ReadBlock]
    private let call: CAPPluginCall
    private var timer: DispatchWorkItem?
    private var completed = false
    private var index = 0
    private var results: [[String: Any]] = []

    init(host: String, port: Int, unit: Int, timeout: Int, blocks: [ReadBlock], call: CAPPluginCall) {
        connection = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: UInt16(port))!, using: .tcp)
        self.unit = unit
        self.timeout = timeout
        self.blocks = blocks
        self.call = call
    }

    func start() {
        queue.async {
            self.armTimeout()
            self.connection.stateUpdateHandler = { state in
                guard !self.completed else { return }
                switch state {
                case .ready: self.readNext()
                case .failed(let error), .waiting(let error): self.finish(error.localizedDescription)
                case .cancelled: self.finish("Modbus connection cancelled")
                default: break
                }
            }
            self.connection.start(queue: self.queue)
        }
    }

    private func armTimeout() {
        timer?.cancel()
        let task = DispatchWorkItem { self.finish("Modbus connection or response timed out") }
        timer = task
        queue.asyncAfter(deadline: .now() + .milliseconds(timeout), execute: task)
    }

    private func readNext() {
        guard !completed else { return }
        guard index < blocks.count else { finish(nil); return }
        armTimeout()
        let block = blocks[index]
        let transaction = index + 1
        let request: [UInt8] = [
            UInt8(transaction >> 8), UInt8(transaction & 255), 0, 0, 0, 6, UInt8(unit), 3,
            UInt8(block.address >> 8), UInt8(block.address & 255),
            UInt8(block.count >> 8), UInt8(block.count & 255)
        ]
        connection.send(content: Data(request), completion: .contentProcessed { error in
            guard !self.completed else { return }
            if let error = error { self.finish(error.localizedDescription); return }
            self.receive(7) { header in
                let length = self.word(header, 4)
                guard self.word(header, 0) == transaction, self.word(header, 2) == 0,
                      Int(header[6]) == self.unit, (3...253).contains(length) else {
                    self.finish("Invalid Modbus MBAP response")
                    return
                }
                self.receive(length - 1) { pdu in
                    if pdu[0] == 0x83, pdu.count == 2 {
                        self.results.append(["error": "Modbus exception \(pdu[1])"])
                    } else {
                        guard pdu[0] == 3, pdu.count == 2 + block.count * 2,
                              Int(pdu[1]) == block.count * 2 else {
                            self.finish("Invalid Modbus function or register byte count")
                            return
                        }
                        let data = (0..<block.count).map { self.word(pdu, 2 + $0 * 2) }
                        self.results.append(["data": data])
                    }
                    self.index += 1
                    self.readNext()
                }
            }
        })
    }

    private func receive(_ count: Int, accumulated: [UInt8] = [], then: @escaping ([UInt8]) -> Void) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: count - accumulated.count) { data, _, isComplete, error in
            guard !self.completed else { return }
            if let error = error { self.finish(error.localizedDescription); return }
            let bytes = accumulated + Array(data ?? Data())
            if bytes.count == count {
                then(bytes)
            } else if isComplete || data == nil || data?.isEmpty == true {
                self.finish("Modbus connection closed before complete response")
            } else {
                self.receive(count, accumulated: bytes, then: then)
            }
        }
    }

    private func word(_ bytes: [UInt8], _ offset: Int) -> Int {
        (Int(bytes[offset]) << 8) | Int(bytes[offset + 1])
    }

    private func finish(_ error: String?) {
        guard !completed else { return }
        completed = true
        timer?.cancel()
        timer = nil
        connection.stateUpdateHandler = nil
        connection.cancel()
        if let error = error {
            call.reject("Modbus read failed: \(error)")
        } else {
            call.resolve(["results": results])
        }
    }
}
