#!/bin/bash

# =============================================================
# Locker Protocol — Test Suite Runner
# =============================================================
#
# Usage:
#   ./run_tests.sh           # Run all tests
#   ./run_tests.sh 01        # Run test 01
#   ./run_tests.sh basic     # Run test matching "basic"
#   ./run_tests.sh 01 03 05  # Run multiple tests
#
# =============================================================

set -e

# Get absolute paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_DIR="$SCRIPT_DIR"

HARDHAT_PID_FILE="$TEST_DIR/.hardhat.pid"

# Counters
TESTS_PASSED=0
TESTS_FAILED=0
FAILED_TESTS=()

# Per-test results for report generation
TEST_NAMES=()
TEST_RESULTS=()
TEST_DURATIONS=()
REPORT_FILE="$TEST_DIR/test-report.md"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# NVM setup
if [ -f "$TEST_DIR/.nvmrc" ] || [ -f "$PROJECT_ROOT/.nvmrc" ]; then
    NVMRC_FILE="$TEST_DIR/.nvmrc"
    [ ! -f "$NVMRC_FILE" ] && NVMRC_FILE="$PROJECT_ROOT/.nvmrc"

    echo -e "${CYAN}🔧 Loading nvm...${NC}"
    export NVM_DIR="$HOME/.nvm"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
        set +e
        source "$NVM_DIR/nvm.sh"
        nvm use
        set -e
        echo -e "${GREEN}✅ Node version: $(node -v)${NC}\n"
    else
        echo -e "${YELLOW}⚠️  nvm not found, using system Node: $(node -v)${NC}\n"
    fi
fi

echo -e "${CYAN}${BOLD}"
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║         Locker Protocol — Smart Contract Test Suite           ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo -e "${NC}\n"

# Cleanup on exit
cleanup() {
    echo -e "\n${YELLOW}Stopping Hardhat node...${NC}"
    if [ -f "$HARDHAT_PID_FILE" ]; then
        local pid=$(cat "$HARDHAT_PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            sleep 1
            if kill -0 "$pid" 2>/dev/null; then
                kill -9 "$pid" 2>/dev/null || true
            fi
        fi
        rm -f "$HARDHAT_PID_FILE"
    fi
    pkill -f "hardhat node" 2>/dev/null || true
    local hardhat_pids=$(lsof -ti:8545 2>/dev/null || true)
    if [ -n "$hardhat_pids" ]; then
        echo "$hardhat_pids" | xargs kill -9 2>/dev/null || true
    fi
    echo -e "${GREEN}✅ Hardhat node stopped${NC}"
}
trap cleanup EXIT INT TERM

# Start Hardhat node
start_hardhat() {
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}STARTING HARDHAT NODE${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

    ./node_modules/.bin/hardhat node > "$TEST_DIR/hardhat-node.log" 2>&1 &
    local pid=$!
    echo $pid > "$HARDHAT_PID_FILE"

    echo -e "Started Hardhat node (PID: $pid)"
    echo -e "Waiting for node to be ready..."

    local max_wait=30
    local waited=0
    while [ $waited -lt $max_wait ]; do
        if grep -q "Started HTTP and WebSocket JSON-RPC server" "$TEST_DIR/hardhat-node.log" 2>/dev/null; then
            echo -e "${GREEN}${BOLD}✅ HARDHAT NODE READY${NC}\n"
            return 0
        fi
        sleep 1
        ((waited++)) || true
    done

    echo -e "${RED}${BOLD}❌ HARDHAT NODE FAILED TO START${NC}"
    echo -e "${YELLOW}Check logs: cat test/hardhat-node.log${NC}\n"
    return 1
}

# Run a single test
run_test() {
    local test_file=$1
    local test_name=$(basename "$test_file" .js)

    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}Running: ${test_name}${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

    local start_time=$(date +%s)

    if ./node_modules/.bin/hardhat run "$test_file" --network localhost; then
        local end_time=$(date +%s)
        local duration=$((end_time - start_time))
        echo -e "${GREEN}${BOLD}✅ PASSED: ${test_name} (${duration}s)${NC}\n"
        ((TESTS_PASSED++))
        TEST_NAMES+=("$test_name")
        TEST_RESULTS+=("✅")
        TEST_DURATIONS+=("${duration}s")
    else
        local end_time=$(date +%s)
        local duration=$((end_time - start_time))
        echo -e "${RED}${BOLD}❌ FAILED: ${test_name} (${duration}s)${NC}\n"
        ((TESTS_FAILED++))
        FAILED_TESTS+=("$test_name")
        TEST_NAMES+=("$test_name")
        TEST_RESULTS+=("❌")
        TEST_DURATIONS+=("${duration}s")
    fi
}

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies...${NC}"
    npm install
fi

# Create symlink to contracts if not present
if [ ! -e "$TEST_DIR/contracts" ]; then
    ln -s "../contracts" "$TEST_DIR/contracts"
fi

# Compile contracts
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}COMPILING CONTRACTS${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

if ./node_modules/.bin/hardhat compile; then
    echo -e "${GREEN}${BOLD}✅ COMPILATION SUCCESSFUL${NC}\n"
else
    echo -e "${RED}${BOLD}❌ COMPILATION FAILED${NC}"
    exit 1
fi

# Start Hardhat node
start_hardhat

# Run setup
if [ -f "$TEST_DIR/tests/00-setup.js" ]; then
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BOLD}RUNNING SETUP (ALWAYS EXECUTED)${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

    SETUP_LOG="$TEST_DIR/setup.log"
    echo -e "${YELLOW}Setup logs: test/setup.log${NC}\n"

    if ./node_modules/.bin/hardhat run "$TEST_DIR/tests/00-setup.js" --network localhost 2>&1 | tee "$SETUP_LOG"; then
        echo -e "${GREEN}${BOLD}✅ SETUP COMPLETED${NC}\n"
    else
        echo -e "${RED}${BOLD}❌ SETUP FAILED! Cannot proceed.${NC}"
        exit 1
    fi
fi

# Determine which tests to run
if [ $# -eq 0 ]; then
    echo -e "${YELLOW}Running all tests...${NC}\n"
    test_files=($(ls "$TEST_DIR/tests/"[0-9][0-9]-*.js 2>/dev/null | grep -v "00-setup.js" | sort))
    test_files=("${test_files[@]/#$TEST_DIR\//}")
else
    test_files=()
    for arg in "$@"; do
        if [[ "$arg" =~ ^[0-9][0-9]$ ]]; then
            matched_file=$(ls "$TEST_DIR/tests/"${arg}-*.js 2>/dev/null | head -n 1)
            if [ -n "$matched_file" ]; then
                test_files+=("${matched_file/#$TEST_DIR\//}")
            else
                echo -e "${RED}No test file found for: $arg${NC}"
                exit 1
            fi
        elif [[ "$arg" =~ ^[0-9][0-9]-.*\.js$ ]]; then
            test_files+=("tests/$arg")
        elif [[ "$arg" =~ ^[0-9][0-9]-.*$ ]]; then
            test_files+=("tests/$arg.js")
        else
            matched_file=$(ls "$TEST_DIR/tests/"*${arg}*.js 2>/dev/null | grep -v "00-setup.js" | head -n 1)
            if [ -n "$matched_file" ]; then
                test_files+=("${matched_file/#$TEST_DIR\//}")
            else
                echo -e "${RED}No test file found matching: $arg${NC}"
                exit 1
            fi
        fi
    done
fi

# Run tests
TOTAL_TESTS=${#test_files[@]}
echo -e "${CYAN}Found ${TOTAL_TESTS} test(s) to run${NC}\n"

set +e
for test_file in "${test_files[@]}"; do
    if [ ! -f "$test_file" ]; then
        echo -e "${RED}Test file not found: $test_file${NC}"
        ((TESTS_FAILED++))
        continue
    fi
    run_test "$test_file"
done
set -e

# Summary
echo -e "${CYAN}${BOLD}"
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                      TEST SUMMARY                             ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${GREEN}✅ Passed: ${TESTS_PASSED}${NC}"
echo -e "${RED}❌ Failed: ${TESTS_FAILED}${NC}"
echo -e "${CYAN}━━ Total:  ${TOTAL_TESTS}${NC}"

if [ ${#FAILED_TESTS[@]} -gt 0 ]; then
    echo -e "\n${RED}${BOLD}Failed tests:${NC}"
    for test in "${FAILED_TESTS[@]}"; do
        echo -e "${RED}  • $test${NC}"
    done
fi

echo ""

# Generate markdown report for CI
if [ $TESTS_FAILED -eq 0 ]; then
    REPORT_ICON="✅"
    REPORT_STATUS="All tests passed"
else
    REPORT_ICON="❌"
    REPORT_STATUS="${TESTS_FAILED} test(s) failed"
fi

cat > "$REPORT_FILE" << REPORT_EOF
## ${REPORT_ICON} Test Report — Locker Protocol Smart Contracts

| Metric | Value |
|--------|-------|
| **Passed** | ${TESTS_PASSED} |
| **Failed** | ${TESTS_FAILED} |
| **Total** | ${TOTAL_TESTS} |
| **Status** | ${REPORT_STATUS} |

### Results

| Status | Test | Duration |
|--------|------|----------|
REPORT_EOF

for i in "${!TEST_NAMES[@]}"; do
    echo "| ${TEST_RESULTS[$i]} | \`${TEST_NAMES[$i]}\` | ${TEST_DURATIONS[$i]} |" >> "$REPORT_FILE"
done

echo "" >> "$REPORT_FILE"
echo "---" >> "$REPORT_FILE"
echo "_Generated by \`run_tests.sh\` on $(date '+%Y-%m-%d %H:%M:%S %Z')_" >> "$REPORT_FILE"

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}${BOLD}🎉 All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}${BOLD}💥 Some tests failed${NC}"
    exit 1
fi
