# headless_runner.py
import subprocess
import time
import json
import requests
import os

# Load config
with open("config.json", "r") as f:
    CONFIG = json.load(f)

def run_steam_cycle():
    """Run the Steam token grabbing without GUI"""
    # This would need to be implemented without GUI
    # You'd need to adapt the SteamTokenTool class to run headless
    pass

# Keep the script running
while True:
    try:
        run_steam_cycle()
        time.sleep(60)  # Run every minute
    except Exception as e:
        print(f"Error: {e}")
        time.sleep(10)
