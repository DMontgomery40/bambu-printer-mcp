#include <dlfcn.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <sstream>
#include <string>
#include <sys/stat.h>
#include <thread>

// This small adapter intentionally mirrors the public C++ ABI declarations
// used by Bambu Studio's optional networking plug-in.  The plug-in is loaded
// at runtime, so the MCP remains usable on machines without Bambu Studio.
namespace BBL {

using OnLocalConnectedFn = std::function<void(int, std::string, std::string)>;
using OnUpdateStatusFn = std::function<void(int, int, std::string)>;
using WasCancelledFn = std::function<bool()>;

struct PrintParams {
    std::string dev_id;
    std::string task_name;
    std::string project_name;
    std::string preset_name;
    std::string filename;
    std::string config_filename;
    int plate_index = 0;
    std::string ftp_folder;
    std::string ftp_file;
    std::string ftp_file_md5;
    std::string nozzle_mapping;
    std::string ams_mapping;
    std::string ams_mapping2;
    std::string ams_mapping_info;
    std::string nozzles_info;
    std::string connection_type;
    std::string comments;
    int origin_profile_id = 0;
    int stl_design_id = 0;
    std::string origin_model_id;
    std::string print_type;
    std::string dst_file;
    std::string dev_name;
    std::string dev_ip;
    bool use_ssl_for_ftp = true;
    bool use_ssl_for_mqtt = true;
    std::string username;
    std::string password;
    bool task_bed_leveling = true;
    bool task_flow_cali = true;
    bool task_vibration_cali = true;
    bool task_layer_inspect = false;
    bool task_record_timelapse = false;
    bool task_timelapse_use_internal = false;
    bool task_use_ams = true;
    std::string task_bed_type;
    std::string extra_options;
    int auto_bed_leveling = 0;
    int auto_flow_cali = 0;
    int auto_offset_cali = 0;
    int extruder_cali_manual_mode = -1;
    bool task_ext_change_assist = false;
    bool try_emmc_print = true;
    std::string svc_context;
    std::string slicer_uid;
    std::string queue_plate_id;
};

} // namespace BBL

namespace {

using FtErr = int;
struct FT_TunnelHandle;
using FtAbiVersionFn = int (*)();
using FtTunnelCreateFn = FtErr (*)(const char *, FT_TunnelHandle **);
using FtTunnelSyncConnectFn = FtErr (*)(FT_TunnelHandle *);
using FtTunnelReleaseFn = void (*)(FT_TunnelHandle *);

using CreateAgentFn = void *(*)(std::string);
using DestroyAgentFn = int (*)(void *);
using InitLogFn = int (*)(void *);
using SetConfigDirFn = int (*)(void *, std::string);
using SetCertFileFn = int (*)(void *, std::string, std::string);
using SetCountryCodeFn = int (*)(void *, std::string);
using StartFn = int (*)(void *);
using SetLocalConnectFn = int (*)(void *, BBL::OnLocalConnectedFn);
using SetPrinterConnectedFn = int (*)(void *, std::function<void(std::string)>);
using SetMessageFn = int (*)(void *, std::function<void(std::string, std::string)>);
using SetLocalMessageFn = int (*)(void *, std::function<void(std::string, std::string)>);
using SetQueueOnMainFn = int (*)(void *, std::function<void(std::function<void()>)>);
using ConnectPrinterFn = int (*)(void *, std::string, std::string, std::string, std::string, bool);
using SendMessageToPrinterFn = int (*)(void *, std::string, std::string, int, int);
using InstallDeviceCertFn = void (*)(void *, std::string, bool);
using UpdateCertFn = int (*)(void *);
using StartLocalPrintFn = int (*)(void *, BBL::PrintParams, BBL::OnUpdateStatusFn, BBL::WasCancelledFn);
using StartSendGcodeToSdcardFn = int (*)(void *, BBL::PrintParams, BBL::OnUpdateStatusFn, BBL::WasCancelledFn, std::function<bool(int, std::string)>);

std::mutex output_mutex;

void outputLine(const std::string &line) {
    std::lock_guard<std::mutex> lock(output_mutex);
    std::cout << line << std::endl;
}

std::string envOr(const char *name, const std::string &fallback = {}) {
    const char *value = std::getenv(name);
    return value && *value ? std::string(value) : fallback;
}

std::string homeDir() {
    return envOr("HOME", "/Users/Shared");
}

std::string defaultPluginPath() {
    // Bambu Connect ships the current X2D networking plug-in. Prefer it when
    // present; older Bambu Studio installations remain a compatible fallback.
    const std::string connectPlugin =
        "/Applications/Bambu Connect.app/Contents/Resources/app.asar.unpacked/plugins/plugins-mac/libbambu_networking.dylib";
    struct stat connectStat {};
    if (stat(connectPlugin.c_str(), &connectStat) == 0 && S_ISREG(connectStat.st_mode)) {
        return connectPlugin;
    }
    return homeDir() + "/Library/Application Support/BambuStudio/plugins/libbambu_networking.dylib";
}

void *symbol(void *handle, const char *name) {
    return dlsym(handle, name);
}

template <typename T>
T requiredSymbol(void *handle, const char *name) {
    dlerror();
    void *raw = symbol(handle, name);
    const char *error = dlerror();
    if (!raw || error) {
        throw std::runtime_error(std::string("missing native symbol ") + name +
                                 (error ? std::string(": ") + error : std::string()));
    }
    return reinterpret_cast<T>(raw);
}

struct NativeApi {
    void *handle = nullptr;
    CreateAgentFn createAgent = nullptr;
    DestroyAgentFn destroyAgent = nullptr;
    InitLogFn initLog = nullptr;
    SetConfigDirFn setConfigDir = nullptr;
    SetCertFileFn setCertFile = nullptr;
    SetCountryCodeFn setCountryCode = nullptr;
    StartFn start = nullptr;
    SetLocalConnectFn setLocalConnect = nullptr;
    SetPrinterConnectedFn setPrinterConnected = nullptr;
    SetMessageFn setMessage = nullptr;
    SetLocalMessageFn setLocalMessage = nullptr;
    SetQueueOnMainFn setQueueOnMain = nullptr;
    ConnectPrinterFn connectPrinter = nullptr;
    SendMessageToPrinterFn sendMessageToPrinter = nullptr;
    InstallDeviceCertFn installDeviceCert = nullptr;
    UpdateCertFn updateCert = nullptr;
    StartLocalPrintFn startLocalPrint = nullptr;
    FtAbiVersionFn ftAbiVersion = nullptr;
    FtTunnelCreateFn ftTunnelCreate = nullptr;
    FtTunnelSyncConnectFn ftTunnelSyncConnect = nullptr;
    FtTunnelReleaseFn ftTunnelRelease = nullptr;
    StartSendGcodeToSdcardFn startSendGcodeToSdcard = nullptr;

    ~NativeApi() {
        if (handle) dlclose(handle);
    }
};

NativeApi loadApi() {
    const std::string plugin = envOr("BAMBU_NATIVE_PLUGIN", defaultPluginPath());
    void *handle = dlopen(plugin.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
        const char *error = dlerror();
        throw std::runtime_error("could not load Bambu networking plug-in: " + plugin +
                                 (error ? std::string(" (") + error + ")" : std::string()));
    }

    NativeApi api;
    api.handle = handle;
    api.createAgent = requiredSymbol<CreateAgentFn>(handle, "bambu_network_create_agent");
    api.destroyAgent = requiredSymbol<DestroyAgentFn>(handle, "bambu_network_destroy_agent");
    api.initLog = requiredSymbol<InitLogFn>(handle, "bambu_network_init_log");
    api.setConfigDir = requiredSymbol<SetConfigDirFn>(handle, "bambu_network_set_config_dir");
    api.setCertFile = requiredSymbol<SetCertFileFn>(handle, "bambu_network_set_cert_file");
    api.setCountryCode = requiredSymbol<SetCountryCodeFn>(handle, "bambu_network_set_country_code");
    api.start = requiredSymbol<StartFn>(handle, "bambu_network_start");
    api.setLocalConnect = requiredSymbol<SetLocalConnectFn>(handle, "bambu_network_set_on_local_connect_fn");
    api.setPrinterConnected = requiredSymbol<SetPrinterConnectedFn>(handle, "bambu_network_set_on_printer_connected_fn");
    api.setMessage = requiredSymbol<SetMessageFn>(handle, "bambu_network_set_on_message_fn");
    api.setLocalMessage = requiredSymbol<SetLocalMessageFn>(handle, "bambu_network_set_on_local_message_fn");
    api.setQueueOnMain = requiredSymbol<SetQueueOnMainFn>(handle, "bambu_network_set_queue_on_main_fn");
    api.connectPrinter = requiredSymbol<ConnectPrinterFn>(handle, "bambu_network_connect_printer");
    api.sendMessageToPrinter = requiredSymbol<SendMessageToPrinterFn>(handle, "bambu_network_send_message_to_printer");
    api.installDeviceCert = requiredSymbol<InstallDeviceCertFn>(handle, "bambu_network_install_device_cert");
    api.updateCert = requiredSymbol<UpdateCertFn>(handle, "bambu_network_update_cert");
    api.startLocalPrint = requiredSymbol<StartLocalPrintFn>(handle, "bambu_network_start_local_print");
    api.startSendGcodeToSdcard = requiredSymbol<StartSendGcodeToSdcardFn>(handle, "bambu_network_start_send_gcode_to_sdcard");
    api.ftAbiVersion = requiredSymbol<FtAbiVersionFn>(handle, "ft_abi_version");
    api.ftTunnelCreate = requiredSymbol<FtTunnelCreateFn>(handle, "ft_tunnel_create");
    api.ftTunnelSyncConnect = requiredSymbol<FtTunnelSyncConnectFn>(handle, "ft_tunnel_sync_connect");
    api.ftTunnelRelease = requiredSymbol<FtTunnelReleaseFn>(handle, "ft_tunnel_release");
    return api;
}

std::string localUrl(const std::string &host, const std::string &token) {
    return "bambu:///local/" + host + "?port=6000&user=bblp&passwd=" + token;
}

struct LocalConnectionState {
    std::mutex mutex;
    std::condition_variable cv;
    bool resolved = false;
    bool ok = false;
    int status = -1;
    std::string message;
};

bool boolEnv(const char *name, bool fallback);

void runProbe(NativeApi &api) {
    const std::string host = envOr("BAMBU_NATIVE_HOST");
    const std::string token = envOr("BAMBU_NATIVE_ACCESS_CODE");
    if (host.empty() || token.empty()) {
        throw std::runtime_error("BAMBU_NATIVE_HOST and BAMBU_NATIVE_ACCESS_CODE are required for --probe");
    }

    // Avoid calling the C++ string-returning symbol in the probe. The tunnel
    // API is C ABI and is the only part needed to verify the X2D route.
    const std::string configDir = envOr("BAMBU_NATIVE_CONFIG_DIR",
                                        homeDir() + "/Library/Application Support/BambuStudio");
    const std::string certDir = envOr("BAMBU_NATIVE_CERT_DIR",
                                      "/Applications/BambuStudio.app/Contents/Resources/cert");
    const std::string certFile = envOr("BAMBU_NATIVE_CERT_FILE", "slicer_base64.cer");
    void *agent = api.createAgent(configDir);
    if (!agent) throw std::runtime_error("bambu_network_create_agent returned null in probe");
    int agentResult = api.setConfigDir(agent, configDir);
    if (agentResult == 0) agentResult = api.initLog(agent);
    if (agentResult == 0) agentResult = api.setCertFile(agent, certDir, certFile);
    if (agentResult == 0) agentResult = api.setCountryCode(agent, envOr("BAMBU_NATIVE_COUNTRY", "US"));
    if (agentResult == 0) agentResult = api.start(agent);
    const std::string version = "plugin-loaded";
    const int abi = api.ftAbiVersion();
    FT_TunnelHandle *tunnel = nullptr;
    const FtErr createResult = api.ftTunnelCreate(localUrl(host, token).c_str(), &tunnel);
    if (createResult != 0 || !tunnel) {
        outputLine("probe=failed stage=tunnel_create result=" + std::to_string(createResult));
        return;
    }

    const FtErr connectResult = api.ftTunnelSyncConnect(tunnel);
    api.ftTunnelRelease(tunnel);
    api.destroyAgent(agent);
    outputLine("probe=local_tunnel version=" + version + " ft_abi=" + std::to_string(abi) +
               " connect_result=" + std::to_string(connectResult));
}

void runMqttProbe(NativeApi &api) {
    const std::string host = envOr("BAMBU_NATIVE_HOST");
    const std::string token = envOr("BAMBU_NATIVE_ACCESS_CODE");
    const std::string serial = envOr("BAMBU_NATIVE_SERIAL");
    if (host.empty() || token.empty() || serial.empty()) {
        throw std::runtime_error("BAMBU_NATIVE_HOST, BAMBU_NATIVE_ACCESS_CODE, and BAMBU_NATIVE_SERIAL are required for --probe-mqtt");
    }

    const std::string configDir = envOr("BAMBU_NATIVE_CONFIG_DIR",
                                        homeDir() + "/Library/Application Support/BambuStudio");
    const std::string certDir = envOr("BAMBU_NATIVE_CERT_DIR",
                                      "/Applications/BambuStudio.app/Contents/Resources/cert");
    const std::string certFile = envOr("BAMBU_NATIVE_CERT_FILE", "slicer_base64.cer");
    void *agent = api.createAgent(configDir);
    if (!agent) throw std::runtime_error("bambu_network_create_agent returned null in MQTT probe");
    const auto destroyAgent = [&]() { api.destroyAgent(agent); };

    int result = api.setConfigDir(agent, configDir);
    if (result == 0) result = api.initLog(agent);
    if (result == 0) result = api.setCertFile(agent, certDir, certFile);
    if (result == 0) result = api.setCountryCode(agent, envOr("BAMBU_NATIVE_COUNTRY", "US"));
    if (result == 0) result = api.start(agent);
    if (result != 0) {
        destroyAgent();
        throw std::runtime_error("MQTT probe setup failed: " + std::to_string(result));
    }
    result = api.setQueueOnMain(agent, [](std::function<void()> callback) {
        if (callback) callback();
    });
    if (result != 0) {
        destroyAgent();
        throw std::runtime_error("set_queue_on_main_fn failed in MQTT probe: " + std::to_string(result));
    }

    auto localConnection = std::make_shared<LocalConnectionState>();
    // Bambu Studio installs the printer's application certificate after the
    // networking plug-in reports the printer connected. Without this call the
    // plug-in can upload to eMMC but cannot encrypt the project_file command
    // and returns -4030 (missing device_pub_key_map).
    const int printerCallbackResult = api.setPrinterConnected(
        agent,
        [agent, serial, &api](std::string devId) {
            if (devId.empty() || devId == serial) {
                api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
                outputLine("native_install_device_cert dev=" + serial);
            }
        });
    if (printerCallbackResult != 0) {
        destroyAgent();
        throw std::runtime_error("set_on_printer_connected_fn failed: " + std::to_string(printerCallbackResult));
    }
    const int messageCallbackResult = api.setMessage(
        agent,
        [agent, serial, &api](std::string devId, std::string message) {
            outputLine("native_message dev=" + devId + " msg=" + message);
            if (message == "wait_info" && (devId.empty() || devId == serial)) {
                api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
                outputLine("native_install_device_cert dev=" + serial + " stage=wait_info");
            }
        });
    if (messageCallbackResult != 0) {
        destroyAgent();
        throw std::runtime_error("set_on_message_fn failed in MQTT probe: " + std::to_string(messageCallbackResult));
    }
    const int localMessageCallbackResult = api.setLocalMessage(
        agent,
        [agent, serial, &api](std::string devId, std::string message) {
            if (message == "wait_info" && (devId.empty() || devId == serial)) {
                outputLine("native_local_message dev=" + devId + " msg=wait_info");
                api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
                outputLine("native_install_device_cert dev=" + serial + " stage=wait_info");
            }
        });
    if (localMessageCallbackResult != 0) {
        destroyAgent();
        throw std::runtime_error("set_on_local_message_fn failed in MQTT probe: " + std::to_string(localMessageCallbackResult));
    }
    result = api.updateCert(agent);
    outputLine("native_update_cert result=" + std::to_string(result));
    const int callbackResult = api.setLocalConnect(agent, [localConnection, serial](int status, std::string devId, std::string message) {
        outputLine("mqtt_probe_connect status=" + std::to_string(status) + " dev=" + devId + " msg=" + message);
        if (!devId.empty() && devId != serial) return;
        {
            std::lock_guard<std::mutex> lock(localConnection->mutex);
            localConnection->resolved = true;
            localConnection->ok = status == 0;
            localConnection->status = status;
            localConnection->message = std::move(message);
        }
        localConnection->cv.notify_all();
    });
    if (callbackResult != 0) {
        destroyAgent();
        throw std::runtime_error("set_on_local_connect_fn failed in MQTT probe: " + std::to_string(callbackResult));
    }
    result = api.connectPrinter(agent, serial, host, "bblp", token, true);
    if (result != 0) {
        destroyAgent();
        throw std::runtime_error("connect_printer failed in MQTT probe: " + std::to_string(result));
    }

    std::unique_lock<std::mutex> lock(localConnection->mutex);
    const bool resolved = localConnection->cv.wait_for(
        lock,
        std::chrono::seconds(10),
        [&localConnection]() { return localConnection->resolved; });
    if (!resolved) {
        lock.unlock();
        destroyAgent();
        throw std::runtime_error("MQTT probe timed out waiting for local-connect callback");
    }
    const int status = localConnection->status;
    const std::string message = localConnection->message;
    const bool ok = localConnection->ok;
    lock.unlock();
    destroyAgent();
    outputLine("probe=mqtt status=" + std::to_string(status) +
               (message.empty() ? std::string{} : " message=" + message));
    if (!ok) std::exit(21);
}

std::string bedTypeForNative(const std::string &bedType) {
    if (bedType == "textured_plate" || bedType == "pte") return "pte";
    if (bedType == "cool_plate" || bedType == "pc") return "pc";
    if (bedType == "engineering_plate" || bedType == "pe") return "pe";
    if (bedType == "hot_plate" || bedType == "pei") return "pei";
    if (bedType == "supertack_plate" || bedType == "suprtack") return "suprtack";
    return bedType;
}

int intEnv(const char *name, int fallback) {
    const std::string value = envOr(name);
    if (value.empty()) return fallback;
    try {
        return std::stoi(value);
    } catch (...) {
        return fallback;
    }
}

bool boolEnv(const char *name, bool fallback) {
    const std::string value = envOr(name);
    if (value.empty()) return fallback;
    return value == "1" || value == "true" || value == "TRUE" || value == "yes";
}

void requestPrinterState(NativeApi &api, void *agent, const std::string &serial) {
    const int pushAll = api.sendMessageToPrinter(
        agent,
        serial,
        R"({"pushing":{"sequence_id":"1","command":"pushall","version":1,"push_target":1}})",
        0,
        0);
    outputLine("native_request command=pushall result=" + std::to_string(pushAll));

    const int version = api.sendMessageToPrinter(
        agent,
        serial,
        R"({"info":{"sequence_id":"2","command":"get_version"}})",
        1,
        0);
    outputLine("native_request command=get_version result=" + std::to_string(version));

    const int accessCode = api.sendMessageToPrinter(
        agent,
        serial,
        R"({"system":{"sequence_id":"3","command":"get_access_code"}})",
        0,
        0);
    outputLine("native_request command=get_access_code result=" + std::to_string(accessCode));
}

enum class NativeOperation {
    Print,
    Upload,
    Command,
};

void runOperation(NativeApi &api, NativeOperation operation) {
    const bool uploadOnly = operation == NativeOperation::Upload;
    const bool commandOnly = operation == NativeOperation::Command;
    const char *confirmation = commandOnly ? "BAMBU_NATIVE_COMMAND_CONFIRM" :
                               uploadOnly ? "BAMBU_NATIVE_UPLOAD_CONFIRM" : "BAMBU_NATIVE_CONFIRM";
    if (envOr(confirmation) != "1") {
        throw std::runtime_error(std::string("refusing native ") +
                                 (commandOnly ? "command" : uploadOnly ? "upload" : "print") +
                                 " without " + confirmation + "=1");
    }

    const std::string host = envOr("BAMBU_NATIVE_HOST");
    const std::string token = envOr("BAMBU_NATIVE_ACCESS_CODE");
    const std::string serial = envOr("BAMBU_NATIVE_SERIAL");
    const std::string file = envOr("BAMBU_NATIVE_FILE");
    const std::string commandJson = envOr("BAMBU_NATIVE_COMMAND_JSON");
    if (host.empty() || token.empty() || serial.empty() ||
        (commandOnly ? commandJson.empty() : file.empty())) {
        throw std::runtime_error(std::string("native ") +
                                 (commandOnly ? "command" : uploadOnly ? "upload" : "print") +
                                 (commandOnly ? " requires host, access code, serial, and command JSON" :
                                                " requires host, access code, serial, and file"));
    }
    struct stat fileStat {};
    if (!commandOnly && (stat(file.c_str(), &fileStat) != 0 || !S_ISREG(fileStat.st_mode))) {
        throw std::runtime_error(std::string("native ") + (uploadOnly ? "upload" : "print") +
                                 " file is not readable: " + file);
    }

    const std::string configDir = envOr("BAMBU_NATIVE_CONFIG_DIR",
                                        homeDir() + "/Library/Application Support/BambuStudio");
    const std::string certDir = envOr("BAMBU_NATIVE_CERT_DIR",
                                      "/Applications/BambuStudio.app/Contents/Resources/cert");
    const std::string certFile = envOr("BAMBU_NATIVE_CERT_FILE", "slicer_base64.cer");
    const std::string country = envOr("BAMBU_NATIVE_COUNTRY", "US");

    void *agent = api.createAgent(configDir);
    if (!agent) throw std::runtime_error("bambu_network_create_agent returned null");
    const auto destroyAgent = [&]() { api.destroyAgent(agent); };

    int result = api.setConfigDir(agent, configDir);
    if (result != 0) { destroyAgent(); throw std::runtime_error("set_config_dir failed: " + std::to_string(result)); }
    result = api.initLog(agent);
    if (result != 0) { destroyAgent(); throw std::runtime_error("init_log failed: " + std::to_string(result)); }
    result = api.setCertFile(agent, certDir, certFile);
    if (result != 0) { destroyAgent(); throw std::runtime_error("set_cert_file failed: " + std::to_string(result)); }
    result = api.setCountryCode(agent, country);
    if (result != 0) { destroyAgent(); throw std::runtime_error("set_country_code failed: " + std::to_string(result)); }
    result = api.start(agent);
    if (result != 0) { destroyAgent(); throw std::runtime_error("network start failed: " + std::to_string(result)); }

    result = api.setQueueOnMain(agent, [](std::function<void()> callback) {
        if (callback) callback();
    });
    if (result != 0) { destroyAgent(); throw std::runtime_error("set_queue_on_main_fn failed: " + std::to_string(result)); }

    auto localConnection = std::make_shared<LocalConnectionState>();
    const int printerCallbackResult = api.setPrinterConnected(
        agent,
        [agent, serial, &api](std::string devId) {
            if (devId.empty() || devId == serial) {
                api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
                outputLine("native_install_device_cert dev=" + serial + " stage=printer_connected");
            }
        });
    if (printerCallbackResult != 0) {
        destroyAgent();
        throw std::runtime_error("set_on_printer_connected_fn failed: " + std::to_string(printerCallbackResult));
    }
    const int callbackResult = api.setLocalConnect(agent, [localConnection, serial, agent, &api](int status, std::string devId, std::string message) {
        outputLine("native_connect status=" + std::to_string(status) + " dev=" + devId + " msg=" + message);
        if (!devId.empty() && devId != serial) return;
        if (status == 0) {
            // The local-connect callback is the point at which Bambu Studio
            // installs the device certificate for LAN-only printers.
            api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
            outputLine("native_install_device_cert dev=" + serial + " stage=local_connect");
        }
        {
            std::lock_guard<std::mutex> lock(localConnection->mutex);
            localConnection->resolved = true;
            localConnection->ok = status == 0;
            localConnection->status = status;
            localConnection->message = std::move(message);
        }
        localConnection->cv.notify_all();
    });
    if (callbackResult != 0) {
        destroyAgent();
        throw std::runtime_error("set_on_local_connect_fn failed: " + std::to_string(callbackResult));
    }
    const int messageCallbackResult = api.setMessage(
        agent,
        [agent, serial, &api](std::string devId, std::string message) {
            if (message == "wait_info" && (devId.empty() || devId == serial)) {
                outputLine("native_message dev=" + devId + " msg=wait_info");
                api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
                outputLine("native_install_device_cert dev=" + serial + " stage=wait_info");
            }
        });
    if (messageCallbackResult != 0) {
        destroyAgent();
        throw std::runtime_error("set_on_message_fn failed: " + std::to_string(messageCallbackResult));
    }
    const int localMessageCallbackResult = api.setLocalMessage(
        agent,
        [agent, serial, &api](std::string devId, std::string message) {
            // GUI_App::process_network_msg handles this exact signal by
            // installing the device certificate again. The plug-in emits it
            // after the async app-key request, which is the point where its
            // device_pub_key_map becomes usable for project_file.
            if (message == "wait_info" && (devId.empty() || devId == serial)) {
                outputLine("native_local_message dev=" + devId + " msg=wait_info");
                api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
                outputLine("native_install_device_cert dev=" + serial + " stage=wait_info");
            }
        });
    if (localMessageCallbackResult != 0) {
        destroyAgent();
        throw std::runtime_error("set_on_local_message_fn failed: " + std::to_string(localMessageCallbackResult));
    }
    result = api.updateCert(agent);
    outputLine("native_update_cert result=" + std::to_string(result));
    result = api.connectPrinter(agent, serial, host, "bblp", token, true);
    if (result != 0) { destroyAgent(); throw std::runtime_error("connect_printer failed: " + std::to_string(result)); }

    // Some plug-in builds emit the local-connect callback without emitting the
    // printer-connected callback. Request installation explicitly as well;
    // the operation is idempotent and is required before encrypted printing.
    api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
    outputLine("native_install_device_cert dev=" + serial);
    result = api.updateCert(agent);
    outputLine("native_update_cert result=" + std::to_string(result) + " stage=connected");

    // connect_printer starts the MQTT loop asynchronously. Calling
    // start_local_print immediately races the CONNACK and makes the plug-in
    // report -4030 (publish MQTT message failed), even though the credentials
    // and the printer are valid. Wait for the local-connect callback before
    // handing the job to the plug-in.
    {
        std::unique_lock<std::mutex> lock(localConnection->mutex);
        const bool resolved = localConnection->cv.wait_for(
            lock,
            std::chrono::seconds(10),
            [&localConnection]() { return localConnection->resolved; });
        if (!resolved) {
            lock.unlock();
            destroyAgent();
            throw std::runtime_error(std::string("local MQTT connection timed out before native ") +
                                     (commandOnly ? "command" : uploadOnly ? "upload" : "print"));
        }
        if (!localConnection->ok) {
            const int status = localConnection->status;
            const std::string message = localConnection->message;
            lock.unlock();
            destroyAgent();
            throw std::runtime_error(
                std::string("local MQTT connection failed before native ") +
                (commandOnly ? "command" : uploadOnly ? "upload" : "print") +
                " status=" + std::to_string(status) +
                (message.empty() ? std::string{} : " message=" + message));
        }
    }

    // GUI_App sends these immediately after a printer connects. They prompt
    // the device to publish its complete state and security metadata before
    // the encrypted project_file message is built.
    requestPrinterState(api, agent, serial);

    // Allow the asynchronous certificate exchange and device-public-key map
    // update to complete before start_local_print publishes project_file.
    if (commandOnly) {
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
        const int qos = std::clamp(intEnv("BAMBU_NATIVE_COMMAND_QOS", 0), 0, 1);
        const int flag = std::clamp(intEnv("BAMBU_NATIVE_COMMAND_FLAG", 0), 0, 1);
        result = api.sendMessageToPrinter(agent, serial, commandJson, qos, flag);
        if (result == -4030 || result == -4) {
            // A protected control may be the first command that asks the
            // printer for its public key. A non-zero synchronous return means
            // it was not queued, so one guarded retry cannot duplicate it.
            const int retryWaitMs = std::max(250, intEnv("BAMBU_NATIVE_CONTROL_RETRY_MS", 1000));
            outputLine("native_retry reason=control_cert_bootstrap wait_ms=" + std::to_string(retryWaitMs));
            std::this_thread::sleep_for(std::chrono::milliseconds(retryWaitMs));
            api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
            const int retryUpdate = api.updateCert(agent);
            outputLine("native_update_cert result=" + std::to_string(retryUpdate) + " stage=control_retry");
            std::this_thread::sleep_for(std::chrono::milliseconds(250));
            result = api.sendMessageToPrinter(agent, serial, commandJson, qos, flag);
        }
        outputLine("native_command result=" + std::to_string(result));
        destroyAgent();
        if (result != 0) std::exit(20);
        return;
    }

    std::this_thread::sleep_for(std::chrono::seconds(3));

    BBL::PrintParams params;
    const std::string projectName = envOr("BAMBU_NATIVE_PROJECT_NAME", "native-mcp-job");
    params.dev_id = serial;
    params.task_name = envOr("BAMBU_NATIVE_TASK_NAME", projectName);
    params.project_name = projectName;
    params.preset_name = envOr("BAMBU_NATIVE_PRESET_NAME", projectName + "_plate_1");
    params.filename = file;
    params.dst_file = envOr("BAMBU_NATIVE_DST_FILE");
    params.config_filename = envOr("BAMBU_NATIVE_CONFIG_FILE", file);
    params.plate_index = intEnv("BAMBU_NATIVE_PLATE_INDEX", 1);
    params.nozzle_mapping = envOr("BAMBU_NATIVE_NOZZLE_MAPPING");
    params.ams_mapping = envOr("BAMBU_NATIVE_AMS_MAPPING");
    params.ams_mapping2 = envOr("BAMBU_NATIVE_AMS_MAPPING2");
    params.ams_mapping_info = envOr("BAMBU_NATIVE_AMS_MAPPING_INFO");
    params.nozzles_info = envOr("BAMBU_NATIVE_NOZZLES_INFO");
    params.connection_type = "lan";
    params.dev_ip = host;
    params.use_ssl_for_ftp = true;
    params.use_ssl_for_mqtt = true;
    params.username = "bblp";
    params.password = token;
    params.task_bed_leveling = boolEnv("BAMBU_NATIVE_BED_LEVELING", true);
    params.task_flow_cali = boolEnv("BAMBU_NATIVE_FLOW_CALIBRATION", true);
    params.task_vibration_cali = boolEnv("BAMBU_NATIVE_VIBRATION_CALIBRATION", true);
    params.task_layer_inspect = boolEnv("BAMBU_NATIVE_LAYER_INSPECT", false);
    params.task_record_timelapse = boolEnv("BAMBU_NATIVE_TIMELAPSE", false);
    params.task_timelapse_use_internal = boolEnv("BAMBU_NATIVE_TIMELAPSE_INTERNAL", false);
    params.task_use_ams = boolEnv("BAMBU_NATIVE_USE_AMS", true);
    params.task_bed_type = bedTypeForNative(envOr("BAMBU_NATIVE_BED_TYPE", "textured_plate"));
    params.auto_bed_leveling = intEnv("BAMBU_NATIVE_AUTO_BED_LEVELING", 0);
    params.auto_flow_cali = intEnv("BAMBU_NATIVE_AUTO_FLOW_CALI", 0);
    params.auto_offset_cali = intEnv("BAMBU_NATIVE_AUTO_OFFSET_CALI", 0);
    params.extruder_cali_manual_mode = intEnv("BAMBU_NATIVE_EXTRUDER_CALI_MANUAL_MODE", -1);
    params.task_ext_change_assist = boolEnv("BAMBU_NATIVE_EXTERNAL_CHANGE_ASSIST", false);
    params.try_emmc_print = boolEnv("BAMBU_NATIVE_TRY_EMMC_PRINT", true);
    params.print_type = envOr("BAMBU_NATIVE_PRINT_TYPE", "from_normal");

    const BBL::OnUpdateStatusFn update = [](int status, int code, std::string message) {
        outputLine("native_update status=" + std::to_string(status) + " code=" +
                   std::to_string(code) + " msg=" + message);
    };
    const BBL::WasCancelledFn cancel = []() { return false; };
    if (uploadOnly) {
        const std::function<bool(int, std::string)> wait = [](int, std::string) { return false; };
        result = api.startSendGcodeToSdcard(agent, params, update, cancel, wait);
    } else {
        result = api.startLocalPrint(agent, params, update, cancel);
        if (result == -4030) {
            // The first encrypted publish can be the plug-in's certificate
            // bootstrap. Keep the agent alive long enough for the printer's
            // response to populate device_pub_key_map, then retry exactly once.
            const int retryWaitSeconds = intEnv("BAMBU_NATIVE_CERT_RETRY_SECONDS", 8);
            outputLine("native_retry reason=cert_bootstrap wait_seconds=" + std::to_string(retryWaitSeconds));
            std::this_thread::sleep_for(std::chrono::seconds(std::max(1, retryWaitSeconds)));
            api.installDeviceCert(agent, serial, boolEnv("BAMBU_NATIVE_LAN_ONLY", true));
            const int retryUpdate = api.updateCert(agent);
            outputLine("native_update_cert result=" + std::to_string(retryUpdate) + " stage=retry");
            std::this_thread::sleep_for(std::chrono::seconds(3));
            result = api.startLocalPrint(agent, params, update, cancel);
        }
    }
    outputLine(std::string(uploadOnly ? "native_upload" : "native_print") + " result=" + std::to_string(result));
    destroyAgent();
    if (result != 0) std::exit(20);
}

} // namespace

int main(int argc, char **argv) {
    try {
        const bool probe = argc == 2 && std::strcmp(argv[1], "--probe") == 0;
        const bool mqttProbe = argc == 2 && std::strcmp(argv[1], "--probe-mqtt") == 0;
        const bool print = argc == 2 && std::strcmp(argv[1], "--print") == 0;
        const bool upload = argc == 2 && std::strcmp(argv[1], "--upload") == 0;
        const bool command = argc == 2 && std::strcmp(argv[1], "--command") == 0;
        if (!probe && !mqttProbe && !print && !upload && !command) {
            std::cerr << "usage: bambu-native-print --probe|--probe-mqtt|--print|--upload|--command" << std::endl;
            return 2;
        }
        NativeApi api = loadApi();
        if (probe) runProbe(api);
        if (mqttProbe) runMqttProbe(api);
        if (print) runOperation(api, NativeOperation::Print);
        if (upload) runOperation(api, NativeOperation::Upload);
        if (command) runOperation(api, NativeOperation::Command);
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "native_error=" << error.what() << std::endl;
        return 1;
    }
}
