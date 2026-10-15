# Copy this file to sync.local.sh (gitignored) to add git options that apply only
# to the clone/pull commands run by sync.sh - never to git globally.
# Corporate network with TLS inspection: skip certificate verification here only.
GITOPTS="-c http.sslVerify=false"
# Better, with the corporate root certificate as a .pem file:
# GITOPTS="-c http.sslCAInfo=/c/path/to/corp-root-ca.pem"
