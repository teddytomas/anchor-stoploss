# Stoploss

A stoploss program that uses vaults to provide asynchronous execution

## Usage

This example requires building the Serum DEX from source, which is done using
git submodules.

### Install Submodules

Pull the source

```
git submodule init
git submodule update
```

### Build the DEX

Build it

```
cd deps/dex/ && cargo build-bpf && cd ../../
```

### Run the Test

Run the test

```
anchor test
```
