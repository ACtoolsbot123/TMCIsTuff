from flask import Flask, request, jsonify
import json
import os
import time

app = Flask(__name__)

# ============================================================
#  CONFIG
# ============================================================
GAME_NAME = "Animal Company"
STEAM_APP_ID = "4551040"

# Token storage file
TOKENS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tokens.json")

# ============================================================
#  TOKEN STORAGE
# ============================================================
def load_tokens():
    if os.path.exists(TOKENS_FILE):
        with open(TOKENS_FILE, "r") as f:
            return json.load(f)
    return {"accounts": []}

def save_tokens(data):
    with open(TOKENS_FILE, "w") as f:
        json.dump(data, f, indent=4)

def store_token(steam_token_hex, auth_response):
    """Store a generated token with its auth data"""
    data = load_tokens()
    entry = {
        "steam_token": steam_token_hex[:40] + "...",
        "steam_token_full": steam_token_hex,
        "token": auth_response.get("token", ""),
        "refresh_token": auth_response.get("refresh_token", ""),
        "account": auth_response.get("account", {}),
        "credits": auth_response.get("credits", 0),
        "created": time.strftime("%Y-%m-%d %H:%M:%S"),
        "timestamp": int(time.time())
    }

    # If tokens nested in 'tokens' object
    if "tokens" in auth_response and isinstance(auth_response["tokens"], dict):
        entry["token"] = auth_response["tokens"].get("token", entry["token"])
        entry["refresh_token"] = auth_response["tokens"].get("refresh_token", entry["refresh_token"])

    # Only keep the latest token
    data["accounts"] = [entry]

    save_tokens(data)
    return entry

# ============================================================
#  ROUTES
# ============================================================

@app.route("/")
def index():
    data = load_tokens()
    accounts = data.get("accounts", [])

    if len(accounts) >= 1:
        acct = accounts[-1]  # latest only

        return f"""<!DOCTYPE html>
<html><head><title>Token</title>
<style>
body {{ background:#0a0a0a; color:#00ff88; font-family:Consolas,monospace; padding:20px; }}
.box {{ background:#111; border:1px solid #00ff88; border-radius:8px; padding:16px; margin:10px 0; word-break:break-all; }}
.label {{ color:#888; font-size:12px; margin-bottom:4px; }}
.token {{ color:#00ff88; font-size:14px; }}
.refresh {{ color:#555; font-size:11px; margin-top:16px; }}
h2 {{ color:#00ff88; }}
</style></head><body>
<h2>ACToken</h2>
<div class="box"><div class="label">token</div><div class="token">{acct.get("token","")}</div></div>
<div class="box"><div class="label">refresh_token</div><div class="token">{acct.get("refresh_token","")}</div></div>
</body></html>"""

    return jsonify({"status": "no tokens yet - run the toolkit"})


@app.route("/health")
def health():
    return jsonify({"status": "healthy"})


@app.route("/api/store", methods=["POST"])
def store():
    """
    Store a token. Toolkit does the Nakama call, then sends result here.

    Request:  {"steam_token": "<hex>", "auth_response": {full nakama response}}
    Response: {success, stored_index, token, refresh_token, ...}
    """
    try:
        data = request.get_json(force=True)
        steam_token = data.get("steam_token", "")
        auth_response = data.get("auth_response", {})

        if not steam_token:
            return jsonify({"error": "Missing 'steam_token'"}), 400

        if not auth_response:
            return jsonify({"error": "Missing 'auth_response'"}), 400

        # Store it
        stored = store_token(steam_token, auth_response)

        return jsonify({
            "success": True,
            "token": stored["token"],
            "refresh_token": stored["refresh_token"],
            "account": auth_response.get("account", {}),
            "credits": auth_response.get("credits", 0),
            "stored_index": len(load_tokens()["accounts"]) - 1
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/tokens", methods=["GET"])
def list_tokens():
    """List all stored tokens"""
    data = load_tokens()
    accounts = []
    for i, acct in enumerate(data.get("accounts", [])):
        accounts.append({
            "index": i,
            "steam_token_preview": acct.get("steam_token", ""),
            "account_name": acct.get("account", {}).get("name", "N/A"),
            "credits": acct.get("credits", 0),
            "token_preview": acct.get("token", "")[:30] + "..." if acct.get("token") else "",
            "created": acct.get("created", "")
        })
    return jsonify({"count": len(accounts), "accounts": accounts})


@app.route("/api/tokens/<int:index>", methods=["GET"])
def get_token(index):
    """Get full token data by index"""
    data = load_tokens()
    accounts = data.get("accounts", [])
    if 0 <= index < len(accounts):
        return jsonify(accounts[index])
    return jsonify({"error": "Index out of range"}), 404


@app.route("/api/token/<int:index>/auth.json", methods=["GET"])
def get_auth_json(index):
    """
    Get auth.json in the exact format needed for Android:
    {"token":"...","refresh_token":"..."}
    """
    data = load_tokens()
    accounts = data.get("accounts", [])
    if 0 <= index < len(accounts):
        acct = accounts[index]
        auth_json = {
            "token": acct.get("token", ""),
            "refresh_token": acct.get("refresh_token", "")
        }
        return jsonify(auth_json)
    return jsonify({"error": "Index out of range"}), 404


@app.route("/api/tokens/<int:index>", methods=["DELETE"])
def delete_token(index):
    """Delete a stored token"""
    data = load_tokens()
    accounts = data.get("accounts", [])
    if 0 <= index < len(accounts):
        removed = accounts.pop(index)
        save_tokens(data)
        return jsonify({"deleted": removed.get("account", {}).get("name", "unknown")})
    return jsonify({"error": "Index out of range"}), 404


@app.route("/api/tokens/clear", methods=["DELETE"])
def clear_tokens():
    """Clear all stored tokens"""
    save_tokens({"accounts": []})
    return jsonify({"status": "all tokens cleared"})


# ============================================================
#  MAIN
# ============================================================
if __name__ == "__main__":
    app.run(debug=True)
