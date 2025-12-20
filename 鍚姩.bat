::[Bat To Exe Converter]
::
::YAwzoRdxOk+EWAjk
::fBw5plQjdCyDJGyX8VAjFAMFFFTXAE+/Fb4I5/jH5umIrAMUV+1f
::YAwzuBVtJxjWCl3EqQJgSA==
::ZR4luwNxJguZRRnk
::Yhs/ulQjdF+5
::cxAkpRVqdFKZSjk=
::cBs/ulQjdF+5
::ZR41oxFsdFKZSDk=
::eBoioBt6dFKZSDk=
::cRo6pxp7LAbNWATEpCI=
::egkzugNsPRvcWATEpCI=
::dAsiuh18IRvcCxnZtBJQ
::cRYluBh/LU+EWAnk
::YxY4rhs+aU+JeA==
::cxY6rQJ7JhzQF1fEqQJQ
::ZQ05rAF9IBncCkqN+0xwdVs0
::ZQ05rAF9IAHYFVzEqQJQ
::eg0/rx1wNQPfEVWB+kM9LVsJDGQ=
::fBEirQZwNQPfEVWB+kM9LVsJDGQ=
::cRolqwZ3JBvQF1fEqQJQ
::dhA7uBVwLU+EWDk=
::YQ03rBFzNR3SWATElA==
::dhAmsQZ3MwfNWATElA==
::ZQ0/vhVqMQ3MEVWAtB9wSA==
::Zg8zqx1/OA3MEVWAtB9wSA==
::dhA7pRFwIByZRRnk
::Zh4grVQjdCyDJGyX8VAjFAMFFFTXAE+/Fb4I5/jHyPiGtEQJTaw6YIq7
::YB416Ek+ZG8=
::
::
::978f952a14a936cc963da21a135fa983
@echo off
chcp 65001 >nul
echo Starting Gravity Launcher...

:: Check for portable node
set "NODE_EXE="
if exist "bin\node-v24.12.0-win-x64\node.exe" (
    set "NODE_EXE=bin\node-v24.12.0-win-x64\node.exe"
) else if exist "bin\node\node.exe" (
    set "NODE_EXE=bin\node\node.exe"
) else (
    :: Try to find any node.exe in bin subdirectories
    for /r "bin" %%f in (node.exe) do (
        if exist "%%f" (
            set "NODE_EXE=%%f"
            goto :found_node
        )
    )
)

:found_node
if defined NODE_EXE (
    echo Using portable Node.js...
) else (
    echo Using system Node.js...
    set "NODE_EXE=node"
)

:: Start server
echo Starting server...
start /b "" "%NODE_EXE%" server/index.js

:: Open browser
echo Opening browser...
timeout /t 3 >nul
start http://localhost:3575

echo Application started!
echo Close this window to keep server running in background, or press Ctrl+C to stop.
cmd /k
