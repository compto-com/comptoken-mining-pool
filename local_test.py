import subprocess
import threading
import signal
import sys
import time
import os

# List to store active subprocesses
processes = []
command1_process = None
script_dir = os.path.dirname(os.path.realpath(__file__))
full_setup_dir = os.path.join(script_dir, "full-setup")
docker_up = f"docker compose -f {full_setup_dir}/docker-compose-mainnet.yml up -d"
docker_down = f"docker compose -f {full_setup_dir}/docker-compose-mainnet.yml down"
cpuminer = f"unbuffer {script_dir}/cpuminer-multi/cpuminer -O 1FhDPLPpw18X4srecguG3MxJYe4a1JsZnd:bitcoin -a sha256d -o stratum+tcp://127.0.0.1:3333 -t 2"
# cpuminer = f"unbuffer {script_dir}/cpuminer-multi/cpuminer -O 1FhDPLPpw18X4srecguG3MxJYe4a1JsZnd:bitcoin -a sha256d -o stratum+tcp://public-pool.io:21496 -t 2"
pool = "npm run start:dev"

# Function to run a command and forward stdout and stderr to terminal
def run_command(cmd, identifier):
    process = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    processes.append(process)
    def forward_output(pipe):
        for line in iter(pipe.readline, b''):
            print(f'[{identifier}] {line.decode()}', end='')
    stdout_thread = threading.Thread(target=forward_output, args=(process.stdout,))
    stderr_thread = threading.Thread(target=forward_output, args=(process.stderr,))
    stdout_thread.start()
    stderr_thread.start()
    process.wait()
    stdout_thread.join()
    stderr_thread.join()

# Signal handler to terminate all subprocesses and Docker Compose on Ctrl+C
def signal_handler(sig, frame):
    print("\nTerminating all processes...")
    # Run `docker compose down` to stop and remove containers on Ctrl+C
    subprocess.run(docker_down, shell=True)
    # Terminate all other processes
    for process in processes:
        process.terminate()  # Send SIGTERM to all processes
    sys.exit(0)

# Attach the signal handler for Ctrl+C
signal.signal(signal.SIGINT, signal_handler)

subprocess.run("./prepare.sh", shell=True, cwd=full_setup_dir)
# Run the Docker Compose command
print(f"Running Docker command: {docker_up}")
subprocess.run(docker_up, shell=True)
print("Docker setup complete. Running additional commands...")
# Run the pool and cpuminer commands in parallel
pool_thread = threading.Thread(target=run_command, args=(pool, 'pool'))
cpuminer_thread = threading.Thread(target=run_command, args=(cpuminer, 'miner'))
pool_thread.start()
time.sleep(5)
cpuminer_thread.start()
pool_thread.join()
cpuminer_thread.join()

print("All commands completed.")
