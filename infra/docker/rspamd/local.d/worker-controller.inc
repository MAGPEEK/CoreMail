# rspamd controller — password for the web UI and API
# Generate with: rspamadm pw --encrypt
# secure_ip: these networks may access the API without a password
# (covers all typical Docker bridge networks)
password = "";
enable_password = "";
bind_socket = "0.0.0.0:11334";
secure_ip = ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
