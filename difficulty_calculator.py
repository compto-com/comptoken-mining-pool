import math

hash_cost_time_of_writing = 47 # $USD / (1 PH/s * 1 day)

secs_in_day = 86400

reasonable_comptoken_price_target = 1.75 # $USD

petahash_cost = hash_cost_time_of_writing / secs_in_day
print("Petahash cost: ${:.6f}".format(petahash_cost))

petahashes_per_comptoken = reasonable_comptoken_price_target / petahash_cost
print("Petahashes per comptoken: {:.0f}".format(petahashes_per_comptoken))

hashes_per_comptoken = petahashes_per_comptoken * 10**15
print(f"Hashes per comptoken: {hashes_per_comptoken}")

day0_target = 0x00000000FFFF0000000000000000000000000000000000000000000000000000
day0_hashes_per_block = 2**32
print(f"Hashes per block on day 0: {day0_hashes_per_block}")

one_comptoken_difficulty = hashes_per_comptoken / day0_hashes_per_block
print(f"One comptoken difficulty: {one_comptoken_difficulty}")

num_comptokens_per_block = 100

comptoken_solve_target = day0_target / one_comptoken_difficulty / num_comptokens_per_block
print(f"Comptoken solve target: {comptoken_solve_target}")

print(f"Comptoken solve target hex: {hex(int(comptoken_solve_target))}")

log256_target = math.log(comptoken_solve_target, 256)
print(f"log256 target: {log256_target:.2f}")

nbits_exponent = math.floor(log256_target) + 1
print(f"nbits exponent: {nbits_exponent}")

# exponent hex
nbits_exponent_hex = hex(nbits_exponent)
print(f"nbits exponent hex: {nbits_exponent_hex}")

nbits_mantissa = comptoken_solve_target / 256**(nbits_exponent-3)
print(f"nbits mantissa: {nbits_mantissa:.2f}")

# mantissa hex
nbits_mantissa_hex = hex(int(nbits_mantissa))
print(f"nbits mantissa hex: {nbits_mantissa_hex}")

nbits = nbits_exponent << 24 | int(nbits_mantissa)
print(f"nbits: {nbits}")
print(f"nbits hex: {hex(nbits)}")

calculate_target = nbits_mantissa * 256**(nbits_exponent-3)
print(f"Calculate target: {calculate_target}")
print(f"Calculate target hex: {hex(int(calculate_target))}")