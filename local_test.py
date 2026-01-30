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

CPU_MINER_USER = "DmnsCLPv6UtiUJQCNjtPA6UXyNHecPk6YUFopcRBKbY"
CPU_MINER_RETRY_DELAY_SEC = 30
CPU_MINER_THREADS = 1
CPU_MINER_MAX_RATE = 1
CPU_MINER_CMD = (
    f"unbuffer {SCRIPT_DIR}/cpuminer-multi/cpuminer"
    f" --user {CPU_MINER_USER} --pass x"
    f" --algo sha256d"
    f" --threads {CPU_MINER_THREADS}"
    f" --retry-pause {CPU_MINER_RETRY_DELAY_SEC}"
    f" --url stratum+tcp://127.0.0.1:3333"
    f" --debug"
)

STRATUM_POOL_CMD = "npm run start:dev"

SOLANA_TEST_VALIDATOR_CMD = "solana-test-validator"

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


def get_env_value(key: str) -> str | None:
    value = os.environ.get(key)
    if value:
        return value
    env_path = os.path.join(SCRIPT_DIR, ".env")
    try:
        with open(env_path, "r") as f:
            for line in f:
                line = line.strip().lower()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    if k.strip() == key.lower():
                        return v.strip().strip('"').strip("'")
    except FileNotFoundError:
        return None
    return None


if __name__ == "__main__":
    # Attach the signal handler for Ctrl+C
    signal.signal(signal.SIGINT, signal_handler)

    cluster = get_env_value("solana_cluster")
    run_validator = cluster == "local"

    test_validator_thread: threading.Thread | None = None
    if run_validator:
        TEST_VALIDATOR_DIR = f"{SCRIPT_DIR}/solana-test-validator"
        process = subprocess.Popen(
            f"rm -r {TEST_VALIDATOR_DIR}/test-ledger && cp -r {TEST_VALIDATOR_DIR}/template/test-ledger {TEST_VALIDATOR_DIR}",
            shell=True,
        )
        process.wait()

    print("Starting the pool and cpuminer commands...")
    pool_thread = threading.Thread(target=run_command, args=(STRATUM_POOL_CMD, 'pool', True))
    cpuminer_thread = threading.Thread(target=run_command, args=(CPU_MINER_CMD, 'miner', True))

    if run_validator:
        test_validator_thread = threading.Thread(
            target=run_command,
            args=(SOLANA_TEST_VALIDATOR_CMD, 'solana-test-validator', False, TEST_VALIDATOR_DIR),
        )
        test_validator_thread.start()
        time.sleep(5)
    else:
        print("Solana cluster is not local; skipping test validator.")

    pool_thread.start()
    time.sleep(5)
    cpuminer_thread.start()

    if test_validator_thread is not None:
        test_validator_thread.join()
    pool_thread.join()
    cpuminer_thread.join()

    print("All commands completed.")
