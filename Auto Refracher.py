import os, sys, ctypes, struct, threading, time, json, requests, subprocess
from ctypes import c_bool, c_int, c_uint32, c_void_p, c_char_p, POINTER, byref, create_string_buffer
import customtkinter as ctk
from tkinter import scrolledtext, messagebox

ctk.set_appearance_mode("Dark")
ctk.set_default_color_theme("green")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")
SDK_DLL = os.path.join(SCRIPT_DIR, "steam_api64.dll")

def load_config():
    """Load config from JSON file"""
    default = {
        "app_name": "Animal Company",
        "steam_app_id": "4551040",
        "api_url": "https://animalcompany.us-east1.nakamacloud.io/v2/account/authenticate/steam?create=false&sync=true",
        "auth_header": "Basic NlVSdVRTbERLS2ZZYnVEVzo=",
        "user_agent": "UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)",
        "unity_version": "6000.3.12f1",
        "android_package": "locaCompany.animalCompany",
        "device_id": "683ae395a238ffeaf1c7e4c380e35c06843358eg",
        "client_user_agent": "SteamVR 9.999.2.3185_1cfe6ef0",
        "game_dir": r"C:\Program Files (x86)\Steam\steamapps\common\Animal Company",
        "custom_vars": {}
    }
    try:
        with open(CONFIG_PATH, "r") as f:
            cfg = json.load(f)
        for k, v in default.items():
            if k not in cfg:
                cfg[k] = v
        return cfg
    except:
        save_config(default)
        return default

def save_config(cfg):
    """Save config to JSON file"""
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=4)

CONFIG = load_config()

if not os.path.exists(SDK_DLL):
    gd = CONFIG.get("game_dir", "")
    if gd:
        for sub in ["EACLauncher_Data", ""]:
            candidate = os.path.join(gd, sub, "Plugins", "x86_64", "steam_api64.dll") if sub else os.path.join(gd, "steam_api64.dll")
            if os.path.exists(candidate):
                SDK_DLL = candidate
                break

if not os.path.exists(SDK_DLL):
    cwd_dll = os.path.join(os.getcwd(), "steam_api64.dll")
    if os.path.exists(cwd_dll):
        SDK_DLL = cwd_dll


class SteamTokenTool:
    def __init__(self):
        self.dll = None
        self.steam_initialized = False
        self.running = False
        self.token_hex = None
        self.token_bytes = None
        self.auth_response = None
        self.adb_available = False
        self.device_name = "Android"
        self.config = CONFIG
        self.build_gui()

    def build_gui(self):
        self.root = ctk.CTk()
        self.root.title(f"Steam Auth Toolkit - {self.config.get('app_name', 'Game')}")
        self.root.geometry("1100x850")
        self.root.resizable(True, True)

        main_frame = ctk.CTkFrame(self.root)
        main_frame.pack(fill="both", expand=True, padx=15, pady=15)

        # Header
        header = ctk.CTkLabel(main_frame, text=f"STEAM AUTH TOOLKIT",
                             font=("Segoe UI", 20, "bold"))
        header.pack(pady=(15, 5))

        game_label = ctk.CTkLabel(main_frame, text=f"Target: {self.config.get('app_name', '?')} | AppID: {self.config.get('steam_app_id', '?')}",
                                 font=("Segoe UI", 12), text_color="#88ccff")
        game_label.pack(pady=(0, 10))

        # Tabs
        self.tabview = ctk.CTkTabview(main_frame)
        self.tabview.pack(fill="both", expand=True)

        self.tab_main = self.tabview.add("Main")
        self.tab_settings = self.tabview.add("Settings")

        self.build_main_tab(self.tab_main)
        self.build_settings_tab(self.tab_settings)

        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.start_adb_monitor()

    def build_main_tab(self, parent):
        # Status bar
        status_frame = ctk.CTkFrame(parent)
        status_frame.pack(fill="x", padx=10, pady=5)

        self.status_label = ctk.CTkLabel(status_frame, text="Status: Idle", font=("Segoe UI", 12))
        self.status_label.pack(side="left", padx=15, pady=8)

        self.appid_label = ctk.CTkLabel(status_frame, text=f"AppID: {self.config.get('steam_app_id', '?')}", font=("Segoe UI", 12))
        self.appid_label.pack(side="right", padx=15, pady=8)

        self.adb_status_label = ctk.CTkLabel(status_frame, text="ADB: Not Connected",
                                            font=("Segoe UI", 12), text_color="#ff6b6b")
        self.adb_status_label.pack(side="right", padx=15, pady=8)

        # Content
        content_frame = ctk.CTkFrame(parent)
        content_frame.pack(fill="both", expand=True, padx=5, pady=10)
        content_frame.grid_columnconfigure(0, weight=1)
        content_frame.grid_columnconfigure(1, weight=1)
        content_frame.grid_rowconfigure(0, weight=1)

        # Left column
        left_frame = ctk.CTkFrame(content_frame)
        left_frame.grid(row=0, column=0, sticky="nsew", padx=(0, 8))
        left_frame.grid_rowconfigure(1, weight=1)
        left_frame.grid_columnconfigure(0, weight=1)

        info_frame = ctk.CTkFrame(left_frame)
        info_frame.pack(fill="x", pady=(0, 8))
        info_frame.grid_columnconfigure(0, weight=1)
        info_frame.grid_columnconfigure(1, weight=1)
        info_frame.grid_columnconfigure(2, weight=1)

        self.credits_label = ctk.CTkLabel(info_frame, text="Credits: N/A", font=("Segoe UI", 12))
        self.credits_label.grid(row=0, column=0, padx=8, pady=8, sticky="w")

        self.account_label = ctk.CTkLabel(info_frame, text="Account: N/A", font=("Segoe UI", 12))
        self.account_label.grid(row=0, column=1, padx=8, pady=8, sticky="w")

        self.tokens_label = ctk.CTkLabel(info_frame, text="Tokens: N/A", font=("Segoe UI", 12))
        self.tokens_label.grid(row=0, column=2, padx=8, pady=8, sticky="w")

        log_label = ctk.CTkLabel(left_frame, text="Log:", font=("Segoe UI", 12, "bold"))
        log_label.pack(anchor="w", pady=(0, 5))

        self.log_area = scrolledtext.ScrolledText(left_frame, height=15,
                                                  bg="#1a1a2e", fg="#00ff88",
                                                  insertbackground="white",
                                                  font=("Consolas", 10))
        self.log_area.pack(fill="both", expand=True)

        # Right column
        right_frame = ctk.CTkFrame(content_frame)
        right_frame.grid(row=0, column=1, sticky="nsew", padx=(8, 0))
        right_frame.grid_rowconfigure(1, weight=1)
        right_frame.grid_rowconfigure(2, weight=0)
        right_frame.grid_rowconfigure(3, weight=0)
        right_frame.grid_columnconfigure(0, weight=1)

        response_label = ctk.CTkLabel(right_frame, text="API Response:", font=("Segoe UI", 12, "bold"))
        response_label.pack(anchor="w", pady=(0, 5))

        self.response_area = scrolledtext.ScrolledText(right_frame, height=10,
                                                       bg="#0d0d1a", fg="#ffcc00",
                                                       insertbackground="white",
                                                       font=("Consolas", 9))
        self.response_area.pack(fill="both", expand=True, pady=(0, 12))

        # Buttons
        btn_frame = ctk.CTkFrame(right_frame)
        btn_frame.pack(fill="x", pady=(0, 5))
        btn_frame.grid_columnconfigure(0, weight=1)
        btn_frame.grid_columnconfigure(1, weight=1)

        self.start_btn = ctk.CTkButton(btn_frame, text="1. Start Steam", command=self.start,
                                       fg_color="#2d8a4e", hover_color="#1a6b36", height=38)
        self.start_btn.grid(row=0, column=0, padx=4, pady=4, sticky="ew")

        self.auth_btn = ctk.CTkButton(btn_frame, text="2. Authenticate API", command=self.authenticate_api,
                                       fg_color="#2d5a8e", hover_color="#1a4070", height=38, state="disabled")
        self.auth_btn.grid(row=0, column=1, padx=4, pady=4, sticky="ew")

        self.write_token_btn = ctk.CTkButton(btn_frame, text="Write to Android",
                                             command=self.write_token_to_android,
                                             fg_color="#8e44ad", hover_color="#6c3483",
                                             height=38, state="disabled")
        self.write_token_btn.grid(row=1, column=0, padx=4, pady=4, sticky="ew")

        self.stop_btn = ctk.CTkButton(btn_frame, text="Stop", command=self.stop,
                                       fg_color="#a83232", hover_color="#8a2020", height=38, state="disabled")
        self.stop_btn.grid(row=1, column=1, padx=4, pady=4, sticky="ew")

        self.copy_btn = ctk.CTkButton(btn_frame, text="Copy Token", command=self.copy_token,
                                       fg_color="#6c3483", hover_color="#512e5f", height=38, state="disabled")
        self.copy_btn.grid(row=2, column=0, padx=4, pady=4, sticky="ew")

        empty_label = ctk.CTkLabel(btn_frame, text="")
        empty_label.grid(row=2, column=1, padx=4, pady=4, sticky="ew")

        # Token display
        token_frame = ctk.CTkFrame(right_frame)
        token_frame.pack(fill="x", pady=(10, 0))

        token_label = ctk.CTkLabel(token_frame, text="Token:", font=("Segoe UI", 11))
        token_label.pack(side="left", padx=12, pady=8)

        self.token_text = ctk.CTkLabel(token_frame, text="No token", font=("Consolas", 10))
        self.token_text.pack(side="left", padx=5, pady=8)

    def build_settings_tab(self, parent):
        """Build the settings panel for configuring any game"""
        scroll_frame = ctk.CTkScrollableFrame(parent)
        scroll_frame.pack(fill="both", expand=True, padx=10, pady=10)

        title = ctk.CTkLabel(scroll_frame, text="Game Configuration",
                            font=("Segoe UI", 16, "bold"))
        title.pack(pady=(5, 15))

        # --- Game Info ---
        section1 = ctk.CTkLabel(scroll_frame, text="Game Info", font=("Segoe UI", 13, "bold"), text_color="#88ccff")
        section1.pack(anchor="w", pady=(10, 5))

        self.settings = {}

        fields = [
            ("app_name", "App / Game Name", "Animal Company"),
            ("steam_app_id", "Steam App ID", "4551040"),
            ("game_dir", "Game Directory (for DLL fallback)", r"C:\Program Files (x86)\Steam\steamapps\common\Animal Company"),
        ]
        for key, label, default in fields:
            self.settings[key] = self._make_field(scroll_frame, label, self.config.get(key, default))

        # --- API Config ---
        section2 = ctk.CTkLabel(scroll_frame, text="API Configuration", font=("Segoe UI", 13, "bold"), text_color="#88ccff")
        section2.pack(anchor="w", pady=(20, 5))

        api_fields = [
            ("api_url", "Nakama API URL (authenticate/steam)", "https://animalcompany.us-east1.nakamacloud.io/v2/account/authenticate/steam?create=false&sync=true"),
            ("auth_header", "Authorization Header", "Basic NlVSdVRTbERLS2ZZYnVEVzo="),
            ("user_agent", "User-Agent", "UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)"),
            ("unity_version", "Unity Version", "6000.3.12f1"),
        ]
        for key, label, default in api_fields:
            self.settings[key] = self._make_field(scroll_frame, label, self.config.get(key, default))

        # --- Android ---
        section3 = ctk.CTkLabel(scroll_frame, text="Android / ADB", font=("Segoe UI", 13, "bold"), text_color="#88ccff")
        section3.pack(anchor="w", pady=(20, 5))

        android_fields = [
            ("android_package", "Android Package Name", "locaCompany.animalCompany"),
            ("device_id", "Device ID (for API vars)", "683ae395a238ffeaf1c7e4c380e35c06843358eg"),
            ("client_user_agent", "Client User-Agent (for API vars)", "SteamVR 9.999.2.3185_1cfe6ef0"),
        ]
        for key, label, default in android_fields:
            self.settings[key] = self._make_field(scroll_frame, label, self.config.get(key, default))

        # --- Buttons ---
        btn_row = ctk.CTkFrame(scroll_frame)
        btn_row.pack(fill="x", pady=(20, 5))
        btn_row.grid_columnconfigure(0, weight=1)
        btn_row.grid_columnconfigure(1, weight=1)
        btn_row.grid_columnconfigure(2, weight=1)

        self.save_btn = ctk.CTkButton(btn_row, text="Save Config", command=self.save_settings,
                                      fg_color="#2d8a4e", hover_color="#1a6b36", height=40)
        self.save_btn.grid(row=0, column=0, padx=4, pady=4, sticky="ew")

        self.reload_btn = ctk.CTkButton(btn_row, text="Reload Config", command=self.reload_settings,
                                        fg_color="#2d5a8e", hover_color="#1a4070", height=40)
        self.reload_btn.grid(row=0, column=1, padx=4, pady=4, sticky="ew")

        self.reset_btn = ctk.CTkButton(btn_row, text="Reset Defaults", command=self.reset_defaults,
                                       fg_color="#a83232", hover_color="#8a2020", height=40)
        self.reset_btn.grid(row=0, column=2, padx=4, pady=4, sticky="ew")

        # --- Presets ---
        section4 = ctk.CTkLabel(scroll_frame, text="Quick Presets", font=("Segoe UI", 13, "bold"), text_color="#88ccff")
        section4.pack(anchor="w", pady=(20, 5))

        presets_frame = ctk.CTkFrame(scroll_frame)
        presets_frame.pack(fill="x", pady=(0, 10))
        presets_frame.grid_columnconfigure(0, weight=1)
        presets_frame.grid_columnconfigure(1, weight=1)
        presets_frame.grid_columnconfigure(2, weight=1)

        presets = [
            ("Animal Company", self.preset_animal_company),
            ("Custom Game", self.preset_clear),
        ]
        for i, (name, cmd) in enumerate(presets):
            btn = ctk.CTkButton(presets_frame, text=name, command=cmd, height=35,
                               fg_color="#444", hover_color="#555")
            btn.grid(row=i//3, column=i%3, padx=4, pady=4, sticky="ew")

        # Status
        self.settings_status = ctk.CTkLabel(scroll_frame, text="", font=("Segoe UI", 11))
        self.settings_status.pack(pady=(10, 5))

    def _make_field(self, parent, label, value):
        """Create a labeled input field"""
        frame = ctk.CTkFrame(parent)
        frame.pack(fill="x", pady=3)

        lbl = ctk.CTkLabel(frame, text=label, font=("Segoe UI", 11), width=280, anchor="w")
        lbl.pack(side="left", padx=(8, 5), pady=5)

        entry = ctk.CTkEntry(frame, font=("Consolas", 11))
        entry.pack(side="left", fill="x", expand=True, padx=(0, 8), pady=5)
        entry.insert(0, str(value))
        return entry

    def _get_settings_values(self):
        """Read all settings entries"""
        vals = {}
        for key, entry in self.settings.items():
            vals[key] = entry.get().strip()
        return vals

    def save_settings(self):
        """Save current settings to config.json"""
        vals = self._get_settings_values()
        self.config.update(vals)
        save_config(self.config)
        self.settings_status.configure(text="Config saved!", text_color="#00ff88")
        self.log(f"Config saved - {vals.get('app_name', '?')} (AppID: {vals.get('steam_app_id', '?')})", "success")

        # Update header
        self.root.title(f"Steam Auth Toolkit - {self.config.get('app_name', 'Game')}")
        self.appid_label.configure(text=f"AppID: {self.config.get('steam_app_id', '?')}")

    def reload_settings(self):
        """Reload config from file"""
        global CONFIG
        CONFIG = load_config()
        self.config = CONFIG
        for key, entry in self.settings.items():
            entry.delete(0, "end")
            entry.insert(0, str(self.config.get(key, "")))
        self.settings_status.configure(text="Config reloaded!", text_color="#88ccff")
        self.log("Config reloaded from file", "info")

    def reset_defaults(self):
        """Reset to defaults"""
        defaults = {
            "app_name": "Animal Company",
            "steam_app_id": "4551040",
            "api_url": "https://animalcompany.us-east1.nakamacloud.io/v2/account/authenticate/steam?create=false&sync=true",
            "auth_header": "Basic NlVSdVRTbERLS2ZZYnVEVzo=",
            "user_agent": "UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)",
            "unity_version": "6000.3.12f1",
            "android_package": "locaCompany.animalCompany",
            "device_id": "683ae395a238ffeaf1c7e4c380e35c06843358eg",
            "client_user_agent": "SteamVR 9.999.2.3185_1cfe6ef0",
            "game_dir": r"C:\Program Files (x86)\Steam\steamapps\common\Animal Company",
            "custom_vars": {}
        }
        for key, entry in self.settings.items():
            entry.delete(0, "end")
            entry.insert(0, str(defaults.get(key, "")))
        self.settings_status.configure(text="Defaults loaded (click Save to apply)", text_color="#ffcc00")

    def preset_animal_company(self):
        """Load Animal Company preset"""
        for key, entry in self.settings.items():
            entry.delete(0, "end")
            entry.insert(0, str(CONFIG.get(key, "")))
        self.settings_status.configure(text="Animal Company preset loaded", text_color="#88ccff")

    def preset_clear(self):
        """Clear all fields for custom game"""
        for key, entry in self.settings.items():
            if key == "android_package":
                entry.delete(0, "end")
                entry.insert(0, "")
            elif key not in ["device_id"]:
                entry.delete(0, "end")
        self.settings_status.configure(text="Fields cleared - enter your game's info", text_color="#ffcc00")

    def get_device_name(self):
        try:
            result = subprocess.run(["adb", "shell", "getprop", "ro.product.model"],
                                   capture_output=True, text=True, timeout=3)
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
            result = subprocess.run(["adb", "shell", "getprop", "ro.product.device"],
                                   capture_output=True, text=True, timeout=3)
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
            manufacturer = subprocess.run(["adb", "shell", "getprop", "ro.product.manufacturer"],
                                         capture_output=True, text=True, timeout=3)
            model = subprocess.run(["adb", "shell", "getprop", "ro.product.model"],
                                  capture_output=True, text=True, timeout=3)
            if manufacturer.returncode == 0 and model.returncode == 0:
                manu = manufacturer.stdout.strip()
                mod = model.stdout.strip()
                if manu and mod:
                    return f"{manu} {mod}"
                elif mod:
                    return mod
            result = subprocess.run(["adb", "shell", "getprop", "ro.kernel.qemu"],
                                   capture_output=True, text=True, timeout=3)
            if result.returncode == 0 and result.stdout.strip() == "1":
                return "Emulator"
            return "Android Device"
        except:
            return "Android Device"

    def start_adb_monitor(self):
        def monitor_adb():
            while True:
                try:
                    result = subprocess.run(["adb", "devices"], capture_output=True, text=True, timeout=5)
                    lines = result.stdout.strip().split('\n')
                    device_found = False
                    if len(lines) > 1:
                        for line in lines[1:]:
                            if line.strip() and "device" in line and "offline" not in line:
                                device_found = True
                                break
                    if device_found and not self.adb_available:
                        self.adb_available = True
                        self.device_name = self.get_device_name()
                        self.root.after(0, self.update_adb_status, True)
                        self.root.after(0, self.update_write_token_button)
                    elif not device_found and self.adb_available:
                        self.adb_available = False
                        self.device_name = "Android"
                        self.root.after(0, self.update_adb_status, False)
                        self.root.after(0, self.update_write_token_button)
                    elif device_found and self.adb_available:
                        new_name = self.get_device_name()
                        if new_name != self.device_name:
                            self.device_name = new_name
                            self.root.after(0, self.update_write_token_button)
                except:
                    if self.adb_available:
                        self.adb_available = False
                        self.device_name = "Android"
                        self.root.after(0, self.update_adb_status, False)
                        self.root.after(0, self.update_write_token_button)
                time.sleep(2)
        threading.Thread(target=monitor_adb, daemon=True).start()

    def update_adb_status(self, connected):
        if connected:
            self.adb_status_label.configure(text=f"ADB: {self.device_name}", text_color="#00ff88")
        else:
            self.adb_status_label.configure(text="ADB: Not Connected", text_color="#ff6b6b")

    def update_write_token_button(self):
        if self.adb_available and self.auth_response:
            self.write_token_btn.configure(text=f"Write to {self.device_name}", state="normal")
        else:
            self.write_token_btn.configure(text="Write to Android", state="disabled")

    def log(self, msg, level="info"):
        if any(x in msg.lower() for x in ['headers:', 'payload size:', 'response headers:', 'getauthsessionticket']):
            return
        prefix = ""
        if level == "success":
            prefix = "[OK] "
        elif level == "error":
            prefix = "[ERR] "
        elif level == "warning":
            prefix = "[WARN] "
        self.log_area.insert("end", f"[{time.strftime('%H:%M:%S')}] {prefix}{msg}\n")
        self.log_area.see("end")
        self.root.update_idletasks()

    def set_status(self, text, status_type="info"):
        colors = {
            "info": "#88ccff",
            "success": "#00ff88",
            "error": "#ff6b6b",
            "warning": "#ffcc00"
        }
        color = colors.get(status_type, "#88ccff")
        self.status_label.configure(text=f"Status: {text}", text_color=color)
        self.root.update_idletasks()

    def update_info_labels(self, response_data):
        if isinstance(response_data, dict):
            if 'credits' in response_data:
                self.credits_label.configure(text=f"Credits: {response_data.get('credits', 0)}")
            if 'account' in response_data:
                account = response_data['account']
                account_name = account.get('name', 'N/A')
                self.account_label.configure(text=f"Account: {account_name}")
                if 'credits' in account:
                    self.credits_label.configure(text=f"Credits: {account.get('credits', 0)}")
            if 'tokens' in response_data:
                tokens = response_data['tokens']
                if isinstance(tokens, dict):
                    token_str = ", ".join([f"{k}: {v}" for k, v in tokens.items()])
                    if len(token_str) > 30:
                        token_str = token_str[:30] + "..."
                    self.tokens_label.configure(text=f"Tokens: {token_str}")
                else:
                    self.tokens_label.configure(text=f"Tokens: {tokens}")
        self.update_write_token_button()
        self.root.update_idletasks()

    def display_response(self, response_data):
        self.response_area.delete("1.0", "end")
        if response_data:
            if isinstance(response_data, dict):
                formatted = json.dumps(response_data, indent=2)
                self.response_area.insert("1.0", formatted)
            else:
                self.response_area.insert("1.0", str(response_data))
            self.update_info_labels(response_data)
            if isinstance(response_data, dict):
                if 'credits' in response_data:
                    self.log(f"Credits: {response_data.get('credits', 0)}", "success")
                if 'account' in response_data:
                    account = response_data['account']
                    self.log(f"Account: {account.get('name', 'N/A')}", "success")
        self.root.update_idletasks()

    def find_export(self, name):
        try:
            kernel32 = ctypes.windll.kernel32
            kernel32.GetProcAddress.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
            kernel32.GetProcAddress.restype = ctypes.c_void_p
            handle = ctypes.c_void_p(self.dll._handle)
            addr = kernel32.GetProcAddress(handle, name.encode())
            return addr
        except:
            return None

    def get_auth_ticket(self):
        self.log("Getting auth ticket...", "info")

        user_ptr = None
        for ver in range(10, 35):
            name = f"SteamAPI_SteamUser_v{ver:03d}"
            addr = self.find_export(name)
            if addr:
                SteamUserFn = ctypes.CFUNCTYPE(ctypes.c_void_p)
                steamuser_func = SteamUserFn(addr)
                user_ptr = steamuser_func()
                if user_ptr:
                    break

        if not user_ptr:
            for name in ["SteamUser", "SteamAPI_SteamUser"]:
                addr = self.find_export(name)
                if addr:
                    fn = ctypes.CFUNCTYPE(ctypes.c_void_p)(addr)
                    user_ptr = fn()
                    if user_ptr:
                        break

        if not user_ptr:
            self.log("Could not get SteamUser", "error")
            return None, None

        get_ticket_addr = self.find_export("SteamAPI_ISteamUser_GetAuthSessionTicket")
        if not get_ticket_addr:
            self.log("Could not find GetAuthSessionTicket", "error")
            return None, None

        GET_AUTH_TICKET_FN = ctypes.CFUNCTYPE(
            c_uint32,
            c_void_p,
            c_void_p,
            c_int,
            ctypes.POINTER(c_uint32),
            c_void_p
        )
        get_ticket = GET_AUTH_TICKET_FN(get_ticket_addr)

        ticket_buf = create_string_buffer(4096)
        ticket_size = c_uint32(0)

        handle = get_ticket(user_ptr, ticket_buf, 4096, byref(ticket_size), None)

        if handle == 0:
            self.log("GetAuthSessionTicket failed, trying fallback...", "warning")
            get_web_addr = self.find_export("SteamAPI_ISteamUser_GetAuthTicketForWebApi")
            if get_web_addr:
                GET_WEB_FN = ctypes.CFUNCTYPE(c_uint32, c_void_p, c_char_p)
                get_web = GET_WEB_FN(get_web_addr)
                web_handle = get_web(user_ptr, b"whatever")
                if web_handle:
                    return f"web_ticket_{web_handle}", None
            return None, None

        if ticket_size.value > 0:
            token_bytes = ticket_buf.raw[:ticket_size.value]
            token_hex = token_bytes.hex()
            self.log(f"Token captured ({ticket_size.value} bytes)", "success")
            return token_hex, token_bytes

        self.log("Ticket size is 0", "error")
        return None, None

    def steam_init(self):
        app_id = self.config.get("steam_app_id", "4551040")
        os.environ["SteamAppId"] = app_id
        os.environ["SteamGameId"] = app_id

        steam_appid_path = os.path.join(SCRIPT_DIR, "steam_appid.txt")
        try:
            with open(steam_appid_path, "w") as f:
                f.write(app_id)
        except:
            pass

        # Re-check DLL with potentially updated game_dir
        global SDK_DLL
        if not os.path.exists(SDK_DLL):
            gd = self.config.get("game_dir", "")
            if gd:
                candidate = os.path.join(gd, "EACLauncher_Data", "Plugins", "x86_64", "steam_api64.dll")
                if os.path.exists(candidate):
                    SDK_DLL = candidate
                else:
                    candidate = os.path.join(gd, "steam_api64.dll")
                    if os.path.exists(candidate):
                        SDK_DLL = candidate

        if not os.path.exists(SDK_DLL):
            self.log(f"steam_api64.dll not found", "error")
            return False

        try:
            self.dll = ctypes.CDLL(SDK_DLL)
        except Exception as e:
            self.log(f"Failed to load DLL: {e}", "error")
            return False

        init_addr = self.find_export("SteamAPI_InitSafe")
        if init_addr:
            INIT_FN = ctypes.CFUNCTYPE(ctypes.c_bool)
            init_fn = INIT_FN(init_addr)
        else:
            init_addr = self.find_export("SteamInternal_SteamAPI_Init")
            if not init_addr:
                self.log("No Init export found", "error")
                return False
            INIT_FN = ctypes.CFUNCTYPE(ctypes.c_bool)
            init_fn = INIT_FN(init_addr)

        try:
            result = init_fn()
        except Exception as e:
            self.log(f"Init failed: {e}", "error")
            return False

        if result:
            self.steam_initialized = True
            self.log("Steam initialized", "success")
            return True
        else:
            self.log("Steam init failed - make sure Steam is running", "error")
            return False

    def steam_shutdown(self):
        if self.dll and self.steam_initialized:
            shutdown_addr = self.find_export("SteamAPI_Shutdown")
            if shutdown_addr:
                SHUTDOWN_FN = ctypes.CFUNCTYPE(None)(shutdown_addr)
                SHUTDOWN_FN()
            self.steam_initialized = False

    def write_token_to_android(self):
        if not self.adb_available:
            self.log("No ADB device connected", "error")
            messagebox.showerror("Error", "No ADB device connected")
            return

        if not self.auth_response:
            self.log("No auth response available", "error")
            messagebox.showerror("Error", "Authenticate with API first")
            return

        self.write_token_btn.configure(state="disabled")
        pkg = self.config.get("android_package", "locaCompany.animalCompany")
        self.log(f"Writing token to {self.device_name}...", "info")
        self.set_status("Writing token...", "info")

        def worker():
            try:
                close_cmd = ["adb", "shell", "am", "force-stop", pkg]
                result = subprocess.run(close_cmd, capture_output=True, text=True, timeout=10)
                if result.returncode == 0:
                    self.log("App closed", "success")

                token = self.auth_response.get('token', '')
                refresh_token = self.auth_response.get('refresh_token', '')

                if 'tokens' in self.auth_response and isinstance(self.auth_response['tokens'], dict):
                    token = self.auth_response['tokens'].get('token', token)
                    refresh_token = self.auth_response['tokens'].get('refresh_token', refresh_token)

                formatted_data = f'{{"token":"{token}","refresh_token":"{refresh_token}"}}'

                remote_path = f"/sdcard/Android/data/{pkg}/files/auth.json"

                self.log(f"Writing token to {remote_path}", "info")

                escaped_json = formatted_data.replace("'", "'\\''")
                write_cmd = ["adb", "shell", f"echo '{escaped_json}' > {remote_path}"]
                result = subprocess.run(write_cmd, capture_output=True, text=True, timeout=10)

                if result.returncode == 0:
                    self.log(f"auth.json written to {self.device_name}", "success")
                    self.log("Start your game.", "info")
                    self.set_status("Token written", "success")
                    messagebox.showinfo("Success", f"Token written to {self.device_name}!\n\nStart your game.")
                else:
                    self.log(f"Write failed", "error")
                    self.set_status("Write failed", "error")
                    messagebox.showerror("Error", "Failed to write file")

            except subprocess.TimeoutExpired:
                self.log("ADB timeout", "error")
                self.set_status("Timeout", "error")
            except Exception as e:
                self.log(f"Error: {e}", "error")
                self.set_status("Error", "error")
            finally:
                self.root.after(0, self.update_write_token_button)

        threading.Thread(target=worker, daemon=True).start()

    def do_auth(self):
        """Hit Nakama + store on server + save to e.txt. Called by auto-loop."""
        try:
            nakama_url = "https://animalcompany.us-east1.nakamacloud.io/v2/account/authenticate/steam?create=false&sync=true"
            nakama_auth = self.config.get("auth_header", "Basic NlVSdVRTbERLS2ZZYnVEVzo=")
            user_agent = self.config.get("user_agent", "UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)")
            unity_ver = self.config.get("unity_version", "6000.3.12f1")
            device_id = self.config.get("device_id", "")
            client_ua = self.config.get("client_user_agent", "")
            server_url = self.config.get("api_url", "")

            payload = {
                "token": self.token_hex,
                "vars": {
                    "clientUserAgent": client_ua,
                    "deviceID": device_id
                }
            }

            headers = {
                "Accept": "*/*",
                "Accept-Encoding": "deflate, gzip",
                "Authorization": nakama_auth,
                "Content-Type": "application/json",
                "User-Agent": user_agent,
                "X-Unity-Version": unity_ver
            }

            resp = requests.post(nakama_url, json=payload, headers=headers, timeout=30)

            if resp.status_code == 200:
                auth_response = resp.json()
                self.auth_response = auth_response
                self.log("Nakama auth OK", "success")
                self.root.after(0, self.display_response, auth_response)
                self.set_status("Authenticated", "success")

                # Save to e.txt
                try:
                    token = auth_response.get("token", "")
                    refresh_token = auth_response.get("refresh_token", "")
                    if "tokens" in auth_response and isinstance(auth_response["tokens"], dict):
                        token = auth_response["tokens"].get("token", token)
                        refresh_token = auth_response["tokens"].get("refresh_token", refresh_token)
                    etxt_path = os.path.join(SCRIPT_DIR, "e.txt")
                    with open(etxt_path, "w") as f:
                        f.write(token)
                    self.log("Token saved to e.txt", "success")
                except Exception as e:
                    self.log(f"e.txt write failed: {e}", "warning")

                # Store on server
                try:
                    store_payload = {
                        "steam_token": self.token_hex,
                        "auth_response": auth_response
                    }
                    store_resp = requests.post(server_url, json=store_payload, timeout=10)
                    if store_resp.status_code == 200:
                        self.log("Token stored on server", "success")
                    else:
                        self.log("Server store skipped", "warning")
                except:
                    self.log("Server store skipped (offline)", "warning")
            else:
                self.log(f"Nakama failed ({resp.status_code})", "error")

        except requests.exceptions.Timeout:
            self.log("Nakama timed out", "error")
        except requests.exceptions.ConnectionError:
            self.log("Connection error", "error")
        except Exception as e:
            self.log(f"Auth error: {e}", "error")

    def authenticate_api(self):
        if not self.token_hex:
            self.log("No token available", "error")
            messagebox.showerror("Error", "Start Steam first")
            return

        self.log("Authenticating with Nakama...", "info")
        self.set_status("Authenticating...", "info")
        self.auth_btn.configure(state="disabled")

        nakama_url = "https://animalcompany.us-east1.nakamacloud.io/v2/account/authenticate/steam?create=false&sync=true"
        nakama_auth = self.config.get("auth_header", "Basic NlVSdVRTbERLS2ZZYnVEVzo=")
        user_agent = self.config.get("user_agent", "UnityPlayer/6000.3.12f1 (UnityWebRequest/1.0, libcurl/8.10.1-DEV)")
        unity_ver = self.config.get("unity_version", "6000.3.12f1")
        device_id = self.config.get("device_id", "")
        client_ua = self.config.get("client_user_agent", "")
        server_url = self.config.get("api_url", "")

        def worker():
            try:
                # Step 1: Hit Nakama directly from PC
                payload = {
                    "token": self.token_hex,
                    "vars": {
                        "clientUserAgent": client_ua,
                        "deviceID": device_id
                    }
                }

                headers = {
                    "Accept": "*/*",
                    "Accept-Encoding": "deflate, gzip",
                    "Authorization": nakama_auth,
                    "Content-Type": "application/json",
                    "User-Agent": user_agent,
                    "X-Unity-Version": unity_ver
                }

                self.log("Hitting Nakama backend...", "info")
                resp = requests.post(nakama_url, json=payload, headers=headers, timeout=30)

                if resp.status_code != 200:
                    self.log(f"Nakama failed ({resp.status_code}): {resp.text[:200]}", "error")
                    self.set_status(f"Failed - {resp.status_code}", "error")
                    return

                try:
                    auth_response = resp.json()
                except:
                    self.log("Invalid JSON from Nakama", "error")
                    self.set_status("Invalid response", "error")
                    return

                self.auth_response = auth_response
                self.log("Nakama auth successful!", "success")
                self.display_response(auth_response)
                self.set_status("Authenticated", "success")

                # Step 2: Store on server (best effort)
                try:
                    store_payload = {
                        "steam_token": self.token_hex,
                        "auth_response": auth_response
                    }
                    store_resp = requests.post(server_url, json=store_payload, timeout=10)
                    if store_resp.status_code == 200:
                        self.log("Token stored on server", "success")
                    else:
                        self.log("Server storage skipped (non-critical)", "warning")
                except:
                    self.log("Server storage skipped (offline)", "warning")

            except requests.exceptions.Timeout:
                self.log("Request timed out", "error")
                self.set_status("Timeout", "error")
            except requests.exceptions.ConnectionError:
                self.log("Connection error", "error")
                self.set_status("Connection Error", "error")
            except Exception as e:
                self.log(f"Error: {e}", "error")
                self.set_status("Error", "error")
            finally:
                self.auth_btn.configure(state="normal")

        threading.Thread(target=worker, daemon=True).start()

    def start(self):
        if self.running:
            return
        self.running = True
        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self.auth_btn.configure(state="disabled")

        self.credits_label.configure(text="Credits: N/A")
        self.account_label.configure(text="Account: N/A")
        self.tokens_label.configure(text="Tokens: N/A")
        self.response_area.delete("1.0", "end")

        self.log("Starting Steam...", "info")
        self.set_status("Initializing Steam...", "info")

        def worker():
            try:
                if not self.steam_init():
                    self.running = False
                    self.start_btn.configure(state="normal")
                    self.stop_btn.configure(state="disabled")
                    self.set_status("Failed", "error")
                    return

                cycle = 0
                while self.running:
                    cycle += 1
                    self.log(f"--- Token cycle #{cycle} ---", "info")

                    # Get fresh steam ticket
                    self.set_status("Getting token...", "info")
                    token_hex, token_bytes = self.get_auth_ticket()

                    if token_hex:
                        self.token_hex = token_hex
                        self.token_bytes = token_bytes
                        display = token_hex[:40] + "..." if len(token_hex) > 40 else token_hex
                        self.token_text.configure(text=display)
                        self.log("Steam ticket captured", "success")

                        # Auto-authenticate with Nakama
                        self.log("Authenticating with Nakama...", "info")
                        self.set_status("Authenticating...", "info")
                        self.do_auth()
                    else:
                        self.set_status("No token", "warning")
                        self.log("Ticket capture failed, retrying next cycle", "warning")

                    # No delay - next token immediately
                    self.log("Grabbing next token...", "info")
                    time.sleep(0.5)

            except Exception as e:
                self.log(f"Error: {e}", "error")
                self.set_status("Error", "error")
                self.running = False
                self.start_btn.configure(state="normal")
                self.stop_btn.configure(state="disabled")

        threading.Thread(target=worker, daemon=True).start()

    def stop(self):
        self.log("Stopping session...", "info")
        self.set_status("Shutting down...", "info")
        self.running = False
        self.steam_shutdown()
        self.start_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")
        self.auth_btn.configure(state="disabled")
        self.copy_btn.configure(state="disabled")
        self.write_token_btn.configure(state="disabled")
        self.set_status("Stopped", "warning")
        self.log("Session stopped", "info")

    def copy_token(self):
        if hasattr(self, 'token_hex') and self.token_hex:
            self.root.clipboard_clear()
            self.root.clipboard_append(self.token_hex)
            self.log("Token copied", "success")

    def on_close(self):
        self.running = False
        self.steam_shutdown()
        self.root.destroy()

    def run(self):
        self.root.mainloop()

if __name__ == "__main__":
    app = SteamTokenTool()
    app.run()
