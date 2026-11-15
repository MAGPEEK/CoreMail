# rspamd controller (port 11334): scanning (/checkv2), Bayes learning, stats.
#
# Values come from the environment of the rspamd container (rspamd exposes
# RSPAMD_<NAME> as env.<NAME>; see docker-compose.yml):
#   RSPAMD_CONTROLLER_PASSWORD   password for the web UI / API from any other
#                                address (scripts/setup.sh generates it). Empty =
#                                no access except from secure_ip.
#   RSPAMD_CONTROLLER_SECURE_IP  the ONE address allowed without a password: the
#                                CoreMail app container (fixed address on the
#                                dedicated "rspamd" network in docker-compose.yml).
#                                CoreMail does not send a controller password yet,
#                                so this must be the app's address.
# Unset secure IP = loopback only (fail closed). Before 8.0.1 every RFC 1918
# network was trusted without a password.
# A hashed password (rspamadm pw --encrypt -p <pw>) is accepted as well.
password = "{= env.CONTROLLER_PASSWORD =}";
enable_password = "{= env.CONTROLLER_PASSWORD =}";
bind_socket = "0.0.0.0:11334";
secure_ip = ["127.0.0.1", "::1"{% if env.CONTROLLER_SECURE_IP %}, "{= env.CONTROLLER_SECURE_IP =}"{% endif %}];
