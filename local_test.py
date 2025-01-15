import subprocess
import threading
import signal
import sys
import time
import os
import io
import typing

SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))
FULL_SETUP_DIR = os.path.join(SCRIPT_DIR, "full-setup")
CPU_MINER_CMD = f"unbuffer {SCRIPT_DIR}/cpuminer-multi/cpuminer -O 1FhDPLPpw18X4srecguG3MxJYe4a1JsZnd:bitcoin -a sha256d -o stratum+tcp://127.0.0.1:3333 -t 2"
STRATUM_POOL_CMD = "npm run start:dev"

# List to store active subprocesses
processes: list[subprocess.Popen[bytes]] = []


# Function to run a command and forward stdout and stderr to terminal
def run_command(cmd: str, identifier: str):
    process = subprocess.Popen(cmd,
                               shell=True,
                               stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE)
    processes.append(process)

    def forward_output(pipe: io.BytesIO):
        for line in iter(pipe.readline, b''):
            print(f'[{identifier}] {line.decode()}', end='')

    stdout_thread = threading.Thread(target=forward_output,
                                     args=(process.stdout, ))
    stderr_thread = threading.Thread(target=forward_output,
                                     args=(process.stderr, ))
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
    # Run the pool and cpuminer commands in parallel
    pool_thread = threading.Thread(target=run_command, args=(STRATUM_POOL_CMD, 'pool'))
    cpuminer_thread = threading.Thread(target=run_command,
                                    args=(CPU_MINER_CMD, 'miner'))
    pool_thread.start()
    time.sleep(5)
    cpuminer_thread.start()
    pool_thread.join()
    cpuminer_thread.join()

    print("All commands completed.")
