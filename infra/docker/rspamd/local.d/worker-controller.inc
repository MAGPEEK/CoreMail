# rspamd Controller — Passwort für das Web-UI und API
# Generiere mit: rspamadm pw --encrypt
# secure_ip: diese Netzwerke dürfen ohne Passwort auf die API zugreifen
# (deckt alle typischen Docker-Bridge-Netze ab)
password = "";
enable_password = "";
bind_socket = "0.0.0.0:11334";
secure_ip = ["127.0.0.1", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
