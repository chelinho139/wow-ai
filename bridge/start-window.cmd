@echo off
cd /d "%~dp0"
start "Claude WoW bridge" cmd /k node supervisor.js
