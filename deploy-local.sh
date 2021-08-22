#!/bin/bash

# this script cleans, builds, and deploys the dex, then it stores the programId in a known file in home dir
# then it deploys the stoploss program 
# then it overwrites the market.json and the token-mints.json in serum-dex-ui-home and serum_vial_home

# so that a local env can be built more easily
solana config set --url http://localhost:8899
# NB make sure git submodule has been init and checked out
cd deps/dex; 
cargo build-bpf;
DEX_PROGRAM_ID="$(solana deploy target/deploy/serum_dex.so | cut -d ':' -f2)";
cd ../..;

F=~/.stoploss-config;
if [ ! -e "$F" ]; then 
    mkdir ~/.stoploss-config; 
fi;

echo -n $DEX_PROGRAM_ID > ~/.stoploss-config/dex-program-address;
cat ~/.stoploss-config/dex-program-address;

STOPLOSS_PROGRAM_ID="$(anchor build | anchor deploy |  grep "Program Id" | cut -d ':' -f2)";
echo -n $STOPLOSS_PROGRAM_ID > ~/.stoploss-config/stoploss-program-address;
cat ~/.stoploss-config/stoploss-program-address;

solana airdrop 10 4BCzwnxvEADwKk1dPtWQbSCNejvuW5m8nxWB1bqjNg2K
solana airdrop 10 4BCzwnxvEADwKk1dPtWQbSCNejvuW5m8nxWB1bqjNg2K
solana airdrop 10 4BCzwnxvEADwKk1dPtWQbSCNejvuW5m8nxWB1bqjNg2K

node deploy-local.js --listmarket AAA BBB
echo "finished"


