import re
import subprocess
import threading
import signal
import sys
import time
import os
import io
import typing

SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))
CPU_MINER_CMD = f"unbuffer {SCRIPT_DIR}/cpuminer-multi/cpuminer --user DmnsCLPv6UtiUJQCNjtPA6UXyNHecPk6YUFopcRBKbY --pass x --algo sha256d --retry-pause 2 --url stratum+tcp://127.0.0.1:3333 --threads 2"
STRATUM_POOL_CMD = "npm run start:dev"

# List to store active subprocesses
processes: list[subprocess.Popen[bytes]] = []


# Function to run a command and forward stdout and stderr to terminal
def run_command(cmd: str, identifier: str, forward_to_terminal: bool, cwd: str | None = None):
    print(f"Starting command [{identifier}]: {cmd}")
    process = subprocess.Popen(cmd,
                               shell=True,
                               stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE,
                               cwd=cwd)
    processes.append(process)

    def forward_output(pipe: io.BytesIO, mode: typing.Literal['a', 'w'], level: str):
        file = f"{SCRIPT_DIR}/logs/{identifier}.log"

        with open(file, mode) as file:
            for line in iter(pipe.readline, b''):
                msg = f'[{identifier}] [{level}] {line.decode()}'
                if forward_to_terminal:
                    print(msg, end='')

                ANSI_ESCAPE = r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])'
                cleaned_msg = re.sub(ANSI_ESCAPE, '', msg)
                file.write(cleaned_msg)
                file.flush()

    stdout_thread = threading.Thread(target=forward_output,
                                     args=(process.stdout, 'w', 'INFO'))
    stderr_thread = threading.Thread(target=forward_output,
                                     args=(process.stderr, 'a', 'ERROR'))
    stdout_thread.start()
    stderr_thread.start()
    process.wait()
    stdout_thread.join()
    stderr_thread.join()


# Signal handler to terminate all subprocesses and Docker Compose on Ctrl+C
def signal_handler(_sig: int, _frame: typing.Any):
    print("\nTerminating all processes...")
    # Terminate all other processes
    for process in processes:
        process.terminate()  # Send SIGTERM to all processes
    sys.exit(0)


if __name__ == "__main__":
    # Attach the signal handler for Ctrl+C
    signal.signal(signal.SIGINT, signal_handler)

    # should we add a way to start the solana-test-validator and compto programs?
    print("Starting the pool and cpuminer commands...")
    pool_thread = threading.Thread(target=run_command, args=(STRATUM_POOL_CMD, 'pool', True))
    cpuminer_thread = threading.Thread(target=run_command, args=(CPU_MINER_CMD, 'miner', True))

    pool_thread.start()
    time.sleep(5)
    cpuminer_thread.start()
    pool_thread.join()
    cpuminer_thread.join()

    print("All commands completed.")
