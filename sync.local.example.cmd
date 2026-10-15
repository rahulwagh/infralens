@echo off
rem Copy this file to sync.local.cmd (gitignored) to add git options that apply
rem only to the clone/pull commands run by sync.cmd - never to git globally.
rem
rem Corporate network with TLS inspection, certificate errors on the Bitbucket
rem host: skip certificate verification for these commands only.
set "GITOPTS=-c http.sslVerify=false"
rem
rem Better, if you can get the corporate root certificate as a .pem file:
rem set "GITOPTS=-c http.sslCAInfo=C:\path\to\corp-root-ca.pem"
rem
rem Several options can be combined:
rem set "GITOPTS=-c http.sslVerify=false -c http.proxy=http://localhost:3128"
