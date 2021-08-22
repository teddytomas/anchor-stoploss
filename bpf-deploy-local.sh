#!/bin/bash

# this script cleans, builds, and bpf-loads the dex (ie starts the cluster with the so directly on the path - faster),
# NOTE: can only do this with the genesis block (ie when the cluster starts up) so must be from a fresh validator
# then it stores the programId in a known file in home dir
# then it overwrites the market.json and the token-mints.json in serum-dex-ui-home and serum_vial_home

# so that a local env can be built more easily

solana config set --url http://localhost:8899

# NB make sure git submodule has been init and checked out

RED='\033[0;31m'    


cd deps/dex; 
cargo build-bpf;
cd ../..;

F=~/.stoploss-config;
if [ ! -e "$F" ]; then 
    mkdir ~/.stoploss-config; 
fi;

DEX_PROGRAM_ID="FjLnqLoJYjSJEhAb5mCVxoRB4W93pfZpbWEJLnsUATu3"
echo -n $DEX_PROGRAM_ID > ~/.stoploss-config/dex-program-address;
cat ~/.stoploss-config/dex-program-address;


anchor build;
STOPLOSS_PROGRAM_ID="fFCaG7wcdoMUvtK2gaZ4E9WGcd1KQp1UYKp38A2E7K8"
echo -n $STOPLOSS_PROGRAM_ID > ~/.stoploss-config/stoploss-program-address;
cat ~/.stoploss-config/stoploss-program-address;

pgrep solana-test-val
pgrep solana-test-val | xargs kill
#if pgrep solana-test-val; then 
#    echo -e "${RED}solana is already running. Please shutdown before running this script. Hint, try pgrep solana-test-val | xargs kill"
#    echo -e "${RED}NOT DEPLOYED."
#    exit 1
#fi

directory=./target/test-ledger;
if [ -e "$directory" ]; then 
    rm -rf ./target/test-ledger/*
fi; 
    

sofile=./target/deploy/anchor_stoploss.so
if [ ! -e "$sofile" ]; then 
    echo -e "${RED}STOPLOSS so file not found, cannot start"
    exit 1
fi

dexsofile=./deps/dex/target/deploy/serum_dex.so
if [ ! -e "$dexsofile" ]; then 
    echo -e "${RED}DEX so file not found, cannot start"
    exit 1
fi


# loads up 2 programs
solana-test-validator --bpf-program fFCaG7wcdoMUvtK2gaZ4E9WGcd1KQp1UYKp38A2E7K8 target/deploy/anchor_stoploss.so  --bpf-program FjLnqLoJYjSJEhAb5mCVxoRB4W93pfZpbWEJLnsUATu3 ./deps/dex/target/deploy/serum_dex.so --ledger ./target/test-ledger > /dev/null 2>&1 &

sleep 1
echo .
sleep 1
echo .
sleep 1
echo .

solana airdrop 20 4BCzwnxvEADwKk1dPtWQbSCNejvuW5m8nxWB1bqjNg2K

anchor idl parse --file programs/anchor-stoploss/src/lib.rs  > idl.json
cp idl.json $DEX_UI_HOME/src/utils/idl.json

node deploy-local.js --listmarket AAA BBB
echo "finished"


