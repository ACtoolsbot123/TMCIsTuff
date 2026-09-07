import os
import sys
import subprocess
import platform
import shutil
import urllib.request
import zipfile
import tempfile
import time

class DependencyInstaller:
    def __init__(self):
        self.packages = ['customtkinter', 'requests']
        self.adb_installed = False
        self.python_installed = True
        self.pip_installed = True
        
    def print_status(self, msg, status="info"):
        colors = {
            "info": "\033[94m",    # Blue
            "success": "\033[92m", # Green
            "error": "\033[91m",   # Red
            "warning": "\033[93m"  # Yellow
        }
        reset = "\033[0m"
        prefix = {
            "info": "[INFO]",
            "success": "[OK]",
            "error": "[ERROR]",
            "warning": "[WARN]"
        }
        print(f"{colors.get(status, '')}{prefix.get(status, '[INFO]')} {msg}{reset}")

    def check_python(self):
        """Check Python version"""
        version = sys.version_info
        if version.major >= 3 and version.minor >= 6:
            self.print_status(f"Python {version.major}.{version.minor}.{version.micro} detected", "success")
            return True
        else:
            self.print_status(f"Python {version.major}.{version.minor} detected - Python 3.6+ required", "error")
            return False

    def check_pip(self):
        """Check if pip is installed"""
        try:
            subprocess.run([sys.executable, "-m", "pip", "--version"], 
                          capture_output=True, check=True)
            self.print_status("pip detected", "success")
            return True
        except:
            self.print_status("pip not found", "error")
            return False

    def check_adb(self):
        """Check if ADB is installed"""
        try:
            result = subprocess.run(["adb", "version"], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                version_line = result.stdout.split('\n')[0] if result.stdout else "ADB"
                self.print_status(f"{version_line}", "success")
                self.adb_installed = True
                return True
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
        
        self.print_status("ADB not found in PATH", "warning")
        return False

    def check_package(self, package):
        """Check if a Python package is installed"""
        try:
            __import__(package)
            self.print_status(f"{package} installed", "success")
            return True
        except ImportError:
            self.print_status(f"{package} not installed", "warning")
            return False

    def install_package(self, package):
        """Install a Python package using pip"""
        self.print_status(f"Installing {package}...", "info")
        try:
            subprocess.run([sys.executable, "-m", "pip", "install", package], 
                         check=True, capture_output=True)
            self.print_status(f"{package} installed successfully", "success")
            return True
        except subprocess.CalledProcessError as e:
            self.print_status(f"Failed to install {package}: {e.stderr.decode()}", "error")
            return False

    def install_adb_windows(self):
        """Install ADB on Windows"""
        self.print_status("Downloading ADB for Windows...", "info")
        
        try:
            # ADB download URL for Windows
            adb_url = "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"
            temp_dir = tempfile.mkdtemp()
            zip_path = os.path.join(temp_dir, "platform-tools.zip")
            
            # Download
            self.print_status("Downloading platform-tools...", "info")
            urllib.request.urlretrieve(adb_url, zip_path)
            
            # Extract
            self.print_status("Extracting files...", "info")
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(temp_dir)
            
            # Find adb.exe
            adb_exe = None
            for root, dirs, files in os.walk(temp_dir):
                if "adb.exe" in files:
                    adb_exe = os.path.join(root, "adb.exe")
                    break
            
            if not adb_exe:
                self.print_status("adb.exe not found in downloaded archive", "error")
                return False
            
            # Ask where to install
            print("\n" + "="*60)
            print("Where would you like to install ADB?")
            print("1. Current directory (./adb/)")
            print("2. AppData (C:\\Users\\YourName\\AppData\\Local\\Android\\Sdk\\platform-tools)")
            print("3. Custom location")
            choice = input("Enter choice (1-3): ").strip()
            
            install_dir = None
            if choice == "1":
                install_dir = os.path.join(os.getcwd(), "adb")
            elif choice == "2":
                appdata = os.environ.get('LOCALAPPDATA', '')
                if appdata:
                    install_dir = os.path.join(appdata, "Android", "Sdk", "platform-tools")
                else:
                    self.print_status("Could not find AppData folder", "error")
                    return False
            elif choice == "3":
                install_dir = input("Enter full path to install ADB: ").strip()
            else:
                self.print_status("Invalid choice", "error")
                return False
            
            # Create directory and copy
            os.makedirs(install_dir, exist_ok=True)
            shutil.copy2(adb_exe, os.path.join(install_dir, "adb.exe"))
            
            # Copy DLL files if they exist
            dll_files = ["AdbWinApi.dll", "AdbWinUsbApi.dll"]
            for dll in dll_files:
                dll_path = os.path.join(os.path.dirname(adb_exe), dll)
                if os.path.exists(dll_path):
                    shutil.copy2(dll_path, os.path.join(install_dir, dll))
            
            self.print_status(f"ADB installed to: {install_dir}", "success")
            
            # Add to PATH
            self.print_status("Would you like to add ADB to PATH? (y/n)", "info")
            add_path = input("> ").strip().lower()
            if add_path in ['y', 'yes']:
                self.add_to_path_windows(install_dir)
            
            # Cleanup
            shutil.rmtree(temp_dir)
            return True
            
        except Exception as e:
            self.print_status(f"Failed to install ADB: {e}", "error")
            return False

    def add_to_path_windows(self, path):
        """Add a directory to Windows PATH"""
        try:
            import winreg
            with winreg.ConnectRegistry(None, winreg.HKEY_CURRENT_USER) as hkey:
                with winreg.OpenKey(hkey, "Environment", 0, winreg.KEY_READ | winreg.KEY_WRITE) as env_key:
                    try:
                        current_path, _ = winreg.QueryValueEx(env_key, "Path")
                    except FileNotFoundError:
                        current_path = ""
                    
                    if path not in current_path:
                        new_path = f"{current_path};{path}" if current_path else path
                        winreg.SetValueEx(env_key, "Path", 0, winreg.REG_EXPAND_SZ, new_path)
                        self.print_status(f"Added {path} to PATH", "success")
                        self.print_status("You may need to restart your terminal for changes to take effect", "warning")
                    else:
                        self.print_status(f"{path} already in PATH", "info")
        except Exception as e:
            self.print_status(f"Failed to add to PATH: {e}", "error")
            self.print_status("You can manually add it to PATH via Environment Variables", "info")

    def install_tkinter_windows(self):
        """Guide user to install tkinter on Windows"""
        self.print_status("tkinter not found!", "error")
        print("\n" + "="*60)
        print("To install tkinter on Windows:")
        print("1. Download Python from https://www.python.org/downloads/")
        print("2. During installation, make sure to check 'tcl/tk and IDLE'")
        print("3. Or reinstall Python and select the tkinter option")
        print("="*60)
        return False

    def install_tkinter_linux(self):
        """Guide user to install tkinter on Linux"""
        self.print_status("tkinter not found!", "error")
        print("\n" + "="*60)
        print("To install tkinter on Linux:")
        print("Ubuntu/Debian: sudo apt-get install python3-tk")
        print("Fedora: sudo dnf install python3-tkinter")
        print("Arch: sudo pacman -S tk")
        print("="*60)
        return False

    def check_tkinter(self):
        """Check if tkinter is installed"""
        try:
            import tkinter
            self.print_status("tkinter installed", "success")
            return True
        except ImportError:
            self.print_status("tkinter not installed", "error")
            if platform.system() == "Windows":
                return self.install_tkinter_windows()
            else:
                return self.install_tkinter_linux()

    def run(self):
        """Main installer function"""
        print("\n" + "="*60)
        print(" Nexar Dependencies Installer")
        print("="*60 + "\n")
        
        # Check platform
        if platform.system() != "Windows":
            self.print_status(f"Detected: {platform.system()}", "warning")
            self.print_status("This tool is designed for Windows. Some features may not work.", "warning")
            print()
        
        # Check Python
        if not self.check_python():
            self.print_status("Please install Python 3.6+", "error")
            return
        
        # Check pip
        if not self.check_pip():
            self.print_status("Please install pip", "error")
            return
        
        print("\n" + "-"*60)
        print("Checking Python packages...")
        print("-"*60)
        
        # Check and install Python packages
        for package in self.packages:
            if not self.check_package(package):
                self.print_status(f"Installing {package}...", "info")
                if self.install_package(package):
                    self.print_status(f"✓ {package} installed", "success")
                else:
                    self.print_status(f"✗ Failed to install {package}", "error")
            print()
        
        # Check tkinter
        print("-"*60)
        print("Checking tkinter...")
        print("-"*60)
        self.check_tkinter()
        print()
        
        # Check ADB
        print("-"*60)
        print("Checking ADB...")
        print("-"*60)
        if not self.check_adb():
            print("\nADB is required for writing tokens to Android devices.")
            print("Would you like to install ADB automatically? (y/n)")
            choice = input("> ").strip().lower()
            if choice in ['y', 'yes']:
                if platform.system() == "Windows":
                    self.install_adb_windows()
                else:
                    self.print_status("Please install ADB manually for your platform", "info")
        
        print("\n" + "="*60)
        print(" Installation Summary")
        print("="*60)
        
        # Final summary
        all_ok = True
        for package in self.packages:
            if self.check_package(package):
                print(f"  ✓ {package}")
            else:
                print(f"  ✗ {package} - NOT INSTALLED")
                all_ok = False
        
        if self.check_tkinter():
            print("  ✓ tkinter")
        else:
            print("  ✗ tkinter - NOT INSTALLED")
            all_ok = False
        
        if self.adb_installed:
            print("  ✓ ADB")
        else:
            print("  ✗ ADB - NOT INSTALLED")
            all_ok = False
        
        print("\n" + "="*60)
        if all_ok:
            self.print_status("All dependencies installed successfully!", "success")
        else:
            self.print_status("Some dependencies are missing. Please install them manually.", "warning")
            print("\nTo install missing Python packages manually:")
            print("  pip install customtkinter requests")
            print("\nFor ADB installation, visit:")
            print("  https://developer.android.com/studio/command-line/adb")
        
        print("\nPress Enter to exit...")
        input()

if __name__ == "__main__":
    installer = DependencyInstaller()
    installer.run()