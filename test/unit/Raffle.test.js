const { network, getNamedAccounts, deployments, ethers } = require("hardhat")
const {developmentChains,networkConfig} = require("../../helper-hardhat-config")
const { assert, expect } = require("chai")



!developmentChains.includes(network.name) 
? describe.skip
:describe("Raffle Unit Tests",function (){
    let raffle, vrfCoordinatorV2Mock,raffleEntranceFee, deplooyer,interval
    const chainId = network.config.chainId
    beforeEach(async function(){
        const {deployer} = await getNamedAccounts()
        deplooyer = deployer
        await deployments.fixture(["all"])
        raffle = await ethers.getContract("Raffle", deployer)
        vrfCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock",deployer)
        raffleEntranceFee = await  raffle.getEntranceFee()
        interval = await raffle.getInterval()
           
    })

    describe("constructor",async function(){
        it("initializes the raffle correctly", async function(){
            const raffleState = await raffle.getRaffleState()
            const interval = await raffle.getInterval()
            assert.equal(raffleState.toString(),"0")
            assert.equal(interval.toString(),networkConfig[chainId]["interval"])

        })
    })
    describe('enterRaffle',async () => {
      it("revert when you don't pay enough",async function(){
        await expect(raffle.enterRaffle()).to.be.revertedWith("Raffle__SendMoreToEnterRaffle")
      })
      it("records players when they enter",async function(){
        await raffle.enterRaffle({value: raffleEntranceFee})
        const playerFromContract = await raffle.getPlayer(0)
        assert.equal(playerFromContract,deplooyer)
      })
      it("emits event on enter", async function(){
        await expect(raffle.enterRaffle({value:raffleEntranceFee})).to.emit(raffle,"RaffleEnter")
      })
      it("doesnt allow entrance when raffle is calculating", async function(){
        await raffle.enterRaffle({value:raffleEntranceFee})
        await network.provider.send("evm_increaseTime",[interval.toNumber() + 1])
        await network.provider.send("evm_mine",[])
        //we pretend to be a chainlink keeper
        await raffle.performUpkeep([])
        await expect(raffle.enterRaffle({value:raffleEntranceFee})).to.be.revertedWith("Raffle__RaffleNotOpen")
      })
    })
    describe("checkUpKeep", async function(){
        it("returns false if people haven't sent any ETH", async function(){
            await network.provider.send("evm_increaseTime",[interval.toNumber() +1])
            await network.provider.send("evm_mine",[])
            const {upKeepNeeded}  = await raffle.callStatic.checkUpkeep([])
            assert(!upKeepNeeded)
        })
        // it("returns fasle if raffle isn't open", async function(){
        //     await raffle.enterRaffle({value:raffleEntranceFee})
        //     await network.provider.send("evm_increaseTime",[interval.toNumber() +1])
        //     await network.provider.send("evm_mine",[])
        //     await raffle.performUpkeep(/*"0x"*/ [])
        //     const raffleState = await raffle.getRaffleState()
            
        //     const {upKeepNeeded}  = await raffle.callStatic.checkUpkeep([])
        //     assert.equal(raffleState.toString(),"1")
        //     assert.equal(upKeepNeeded,false)

        // })
        it("returns false if raffle isn't open", async function (){
            await raffle.enterRaffle({ value: raffleEntranceFee })
            await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
            await network.provider.request({ method: "evm_mine", params: [] })
            await raffle.performUpkeep([]) // changes the state to calculating
            const raffleState = await raffle.getRaffleState() // stores the new state
            const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x") // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
            assert.equal(raffleState.toString() == "1", upkeepNeeded == false)
        })
        it("returns false if enough time hasn't passed", async () => {
            await raffle.enterRaffle({ value: raffleEntranceFee })
            await network.provider.send("evm_increaseTime", [interval.toNumber() - 5]) // use a higher number here if this test fails
            await network.provider.request({ method: "evm_mine", params: [] })
            const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x") // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
            assert(!upkeepNeeded)
        })
        it("returns true if enough time has passed, has players, eth, and is open", async () => {
            await raffle.enterRaffle({ value: raffleEntranceFee })
            await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
            await network.provider.request({ method: "evm_mine", params: [] })
            const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x") // upkeepNeeded = (timePassed && isOpen && hasBalance && hasPlayers)
            assert(upkeepNeeded)
        })
    })
    describe("performUpKeep", function(){
        it("it can only run if checkUpKeep is true", async function(){
            await raffle.enterRaffle({value: raffleEntranceFee})
            await network.provider.send("evm_increaseTime",[interval.toNumber() +1])
            await network.provider.send("evm_mine",[])
            const tx = await raffle.performUpkeep([])
            assert(tx)
        })
        it("reverts when checkUpkeep is false", async function(){
            await expect(raffle.performUpkeep([])).to.be.revertedWith("Raffle__UpkeepNotNeeded")
        })
        it("updates the raffle state , emits and event and call the vrf ",async function(){
            await raffle.enterRaffle({value: raffleEntranceFee})
            await network.provider.send("evm_increaseTime",[interval.toNumber() +1])
            await network.provider.send("evm_mine",[])
            const txResponse = await raffle.performUpkeep([])
            const txReceipt = await txResponse.wait(1)
            const requestId = txReceipt.events[1].args.requestId
            const raffleState = await raffle.getRaffleState()
            assert(requestId.toNumber() > 0)
            assert(raffleState.toString() == "1")
            

        })
    })
    describe("fulfillRandomWords",function(){
        beforeEach(async function(){
            await raffle.enterRaffle({value:raffleEntranceFee})
            await network.provider.send("evm_increaseTime",[interval.toNumber() +1])
            await network.provider.send("evm_mine",[])
        })

        it("can only be called after performUpKeep" ,async function(){
            await expect(vrfCoordinatorV2Mock.fulfillRandomWords(0,raffle.address)).to.be.revertedWith("nonexistent request")
        })

        it("picks a winner, resets the lottery and send money", async function(){
            const additionalEntrances = 3 // to test
            const startingIndex = 2
            const accounts = await ethers.getSigners()
            for (let i = startingIndex; i < startingIndex + additionalEntrances; i++) { // i = 2; i < 5; i=i+1
                raffle = raffle.connect(accounts[i]) // Returns a new instance of the Raffle contract connected to player
                await raffle.enterRaffle({ value: raffleEntranceFee })
            }
            const startingTimeStamp = await raffle.getLastTimeStamp()
            // peroformUpkeep (mock being chainlink keeper)
            // fulfillRandomwords(mock being the chainlin vrf)
            // we will have to wait for the fulfillrandomwords to be called
            await new Promise(async (resolve,reject)=>{
                raffle.once("WinnerPicked",async ()=>{
                    console.log("found the event")
                    try{
                        // const recentWinner = await raffle.getRecentWinner()

                        const recentWinner = await raffle.getRecentWinner()
                        console.log(recentWinner)
                        // console.log(accounts[2].address)
                        // console.log(accounts[0].address)
                        // console.log(accounts[1].address)
                        // console.log(accounts[3].address)
                        const raffleState  = await raffle.getRaffleState()
                        const endingTimeStamp = await raffle.getLastTimeStamp()
                        const numPlayer  = await raffle.getNumberOfPlayers()
                        const winnerEndingBalance = await accounts[1].getBalance()
                        assert.equal(numPlayer.toString(),"0")
                        assert.equal(raffleState.toString(),"0")
                        assert(endingTimeStamp> startingTimeStamp)
                        // assert(winnerEndingBalance.toString(),winnerStartingBalance.add(raffleEntranceFee).mul(additionalEntrances).add(raffleEntranceFee).toString())
                        
                    }catch(e){
                        reject(e)
                    }
                    resolve()
                })
                const tx  = await raffle.performUpkeep([])
                const txReceipt = await tx.wait(1)
                // const winnerStartingBalance =  await accounts[2].getBlance()
                
                await vrfCoordinatorV2Mock.fulfillRandomWords(txReceipt.events[1].args.requestId,raffle.address)
                



            })

        })
    })
    
})