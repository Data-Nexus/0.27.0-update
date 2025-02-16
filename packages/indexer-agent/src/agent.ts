/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  formatGRT,
  join,
  Logger,
  Metrics,
  SubgraphDeploymentID,
  timer,
  toAddress,
} from '@graphprotocol/common-ts'
import {
  Action,
  ActionFilter,
  ActionInput,
  ActionItem,
  ActionResult,
  ActionStatus,
  ActionType,
  Allocation,
  AllocationManagementMode,
  allocationRewardsPool,
  AllocationStatus,
  BlockPointer,
  indexerError,
  IndexerErrorCode,
  INDEXING_RULE_GLOBAL,
  IndexingDecisionBasis,
  IndexingRuleAttributes,
  Network,
  NetworkMonitor,
  NetworkSubgraph,
  POIDisputeAttributes,
  ReceiptCollector,
  RewardsPool,
  Subgraph,
  SubgraphIdentifierType,
  CostModelAttributes,
  COST_MODEL_GLOBAL,
} from '@graphprotocol/indexer-common'
import { Indexer } from './indexer'
import { AgentConfig } from './types'
import { BigNumber, utils } from 'ethers'
import PQueue from 'p-queue'
import pMap from 'p-map'
import pFilter from 'p-filter'
import gql from 'graphql-tag'
import { CombinedError } from '@urql/core'

const deploymentInList = (
  list: SubgraphDeploymentID[],
  deployment: SubgraphDeploymentID,
): boolean =>
  list.find(item => item.bytes32 === deployment.bytes32) !== undefined

const deploymentRuleInList = (
  list: IndexingRuleAttributes[],
  deployment: SubgraphDeploymentID,
): boolean =>
  list.find(
    rule =>
      rule.identifierType == SubgraphIdentifierType.DEPLOYMENT &&
      new SubgraphDeploymentID(rule.identifier).toString() ==
        deployment.toString(),
  ) !== undefined

const uniqueDeploymentsOnly = (
  value: SubgraphDeploymentID,
  index: number,
  array: SubgraphDeploymentID[],
): boolean => array.findIndex(v => value.bytes32 === v.bytes32) === index

const uniqueDeployments = (
  deployments: SubgraphDeploymentID[],
): SubgraphDeploymentID[] => deployments.filter(uniqueDeploymentsOnly)

export const convertSubgraphBasedRulesToDeploymentBased = (
  rules: IndexingRuleAttributes[],
  subgraphs: Subgraph[],
  previousVersionBuffer: number,
): IndexingRuleAttributes[] => {
  const toAdd: IndexingRuleAttributes[] = []
  rules.map(rule => {
    if (rule.identifierType !== SubgraphIdentifierType.SUBGRAPH) {
      return rule
    }
    const ruleSubgraph = subgraphs.find(
      subgraph => subgraph.id == rule.identifier,
    )
    if (ruleSubgraph) {
      const latestVersion = ruleSubgraph.versionCount - 1
      const latestDeploymentVersion = ruleSubgraph.versions.find(
        version => version.version == latestVersion,
      )
      if (latestDeploymentVersion) {
        if (!deploymentRuleInList(rules, latestDeploymentVersion!.deployment)) {
          rule.identifier = latestDeploymentVersion!.deployment.toString()
          rule.identifierType = SubgraphIdentifierType.DEPLOYMENT
        }

        const currentTimestamp = Math.floor(Date.now() / 1000)
        if (
          latestDeploymentVersion.createdAt >
          currentTimestamp - previousVersionBuffer
        ) {
          const previousDeploymentVersion = ruleSubgraph.versions.find(
            version => version.version == latestVersion - 1,
          )
          if (
            previousDeploymentVersion &&
            !deploymentRuleInList(rules, previousDeploymentVersion.deployment)
          ) {
            const previousDeploymentRule = { ...rule }
            previousDeploymentRule.identifier =
              previousDeploymentVersion!.deployment.toString()
            previousDeploymentRule.identifierType =
              SubgraphIdentifierType.DEPLOYMENT
            toAdd.push(previousDeploymentRule)
          }
        }
      }
    }
    return rule
  })
  rules.push(...toAdd)
  return rules
}

const deploymentIDSet = (deployments: SubgraphDeploymentID[]): Set<string> =>
  new Set(deployments.map(id => id.bytes32))

class Agent {
  logger: Logger
  metrics: Metrics
  indexer: Indexer
  network: Network
  networkMonitor: NetworkMonitor
  networkSubgraph: NetworkSubgraph
  allocateOnNetworkSubgraph: boolean
  registerIndexer: boolean
  offchainSubgraphs: SubgraphDeploymentID[]
  receiptCollector: ReceiptCollector
  allocationManagementMode: AllocationManagementMode

  constructor(
    logger: Logger,
    metrics: Metrics,
    indexer: Indexer,
    network: Network,
    networkMonitor: NetworkMonitor,
    networkSubgraph: NetworkSubgraph,
    allocateOnNetworkSubgraph: boolean,
    registerIndexer: boolean,
    offchainSubgraphs: SubgraphDeploymentID[],
    receiptCollector: ReceiptCollector,
    allocationManagementMode: AllocationManagementMode,
  ) {
    this.logger = logger.child({ component: 'Agent' })
    this.metrics = metrics
    this.indexer = indexer
    this.network = network
    this.networkMonitor = networkMonitor
    this.networkSubgraph = networkSubgraph
    this.allocateOnNetworkSubgraph = allocateOnNetworkSubgraph
    this.registerIndexer = registerIndexer
    this.offchainSubgraphs = offchainSubgraphs
    this.receiptCollector = receiptCollector
    this.allocationManagementMode = allocationManagementMode
  }

  async start(): Promise<Agent> {
    this.logger.info(`Connect to Graph node(s)`)
    await this.indexer.connect()
    this.logger.info(`Connected to Graph node(s)`)

    // Ensure there is a 'global' indexing rule
    await this.indexer.ensureGlobalIndexingRule()

    // Ensure there is a 'global' cost model
    await this.indexer.ensureGlobalCostModel()

    if (this.registerIndexer) {
      await this.network.register()
    }

    const currentEpoch = timer(600_000).tryMap(
      () => this.network.contracts.epochManager.currentEpoch(),
      {
        onError: err =>
          this.logger.warn(`Failed to fetch current epoch`, { err }),
      },
    )

    const currentEpochStartBlock = currentEpoch.tryMap(
      async () => {
        const startBlockNumber =
          await this.network.contracts.epochManager.currentEpochBlock()
        const startBlock = await this.network.ethereum.getBlock(
          startBlockNumber.toNumber(),
        )
        return {
          number: startBlock.number,
          hash: startBlock.hash,
        }
      },
      {
        onError: err =>
          this.logger.warn(`Failed to fetch start block of current epoch`, {
            err,
          }),
      },
    )

    const channelDisputeEpochs = timer(600_000).tryMap(
      () => this.network.contracts.staking.channelDisputeEpochs(),
      {
        onError: err =>
          this.logger.warn(`Failed to fetch channel dispute epochs`, { err }),
      },
    )

    const maxAllocationEpochs = timer(600_000).tryMap(
      () => this.network.contracts.staking.maxAllocationEpochs(),
      {
        onError: err =>
          this.logger.warn(`Failed to fetch max allocation epochs`, { err }),
      },
    )

    const indexingRules = timer(20_000).tryMap(
      async () => {
        let rules = await this.indexer.indexingRules(true)
        const subgraphRuleIds = rules
          .filter(
            rule => rule.identifierType == SubgraphIdentifierType.SUBGRAPH,
          )
          .map(rule => rule.identifier!)
        const subgraphsMatchingRules = await this.networkMonitor.subgraphs(
          subgraphRuleIds,
        )
        if (subgraphsMatchingRules.length >= 1) {
          const epochLength =
            await this.network.contracts.epochManager.epochLength()
          const blockPeriod = 15
          const bufferPeriod = epochLength.toNumber() * blockPeriod * 100 // 100 epochs
          rules = convertSubgraphBasedRulesToDeploymentBased(
            rules,
            subgraphsMatchingRules,
            bufferPeriod,
          )
        }
        return rules
      },
      {
        onError: error =>
          this.logger.warn(
            `Failed to obtain indexing rules, trying again later`,
            { error },
          ),
      },
    )

    const activeDeployments = timer(60_000).tryMap(
      () => this.indexer.subgraphDeployments(),
      {
        onError: () =>
          this.logger.warn(
            `Failed to obtain active deployments, trying again later`,
          ),
      },
    )

    const targetAllocations = join({
      ticker: timer(240_000),
      indexingRules,
    }).tryMap(
      async () => {
        const rules = await indexingRules.value()

        // Identify subgraph deployments on the network that are worth picking up;
        // these may overlap with the ones we're already indexing
        return rules.length === 0
          ? []
          : await this.network.deploymentsWorthAllocatingTowards(rules)
      },
      {
        onError: () =>
          this.logger.warn(
            `Failed to obtain target allocations, trying again later`,
          ),
      },
    )

    // let targetDeployments be an union of targetAllocations
    // and offchain subgraphs.
    const targetDeployments = join({
      ticker: timer(120_000),
      indexingRules,
      targetAllocations,
    }).tryMap(
      async target => {
        const rules = await indexingRules.value()
        const targetDeploymentIDs = new Set(target.targetAllocations)

        // add offchain subgraphs to the deployment list
        rules
          .filter(
            rule => rule?.decisionBasis === IndexingDecisionBasis.OFFCHAIN,
          )
          .map(rule => {
            targetDeploymentIDs.add(new SubgraphDeploymentID(rule.identifier))
          })
        return rules.length === 0
          ? []
          : [...targetDeploymentIDs, ...this.offchainSubgraphs]
      },
      {
        onError: () =>
          this.logger.warn(
            `Failed to obtain target deployments, trying again later`,
          ),
      },
    )

    const activeAllocations = timer(120_000).tryMap(
      () => this.networkMonitor.allocations(AllocationStatus.ACTIVE),
      {
        onError: () =>
          this.logger.warn(
            `Failed to obtain active allocations, trying again later`,
          ),
      },
    )

    const recentlyClosedAllocations = join({
      activeAllocations,
      currentEpoch,
    }).tryMap(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ({ activeAllocations, currentEpoch }) =>
        this.networkMonitor.recentlyClosedAllocations(
          currentEpoch.toNumber(),
          1, //TODO: Parameterize with a user provided value
        ),
      {
        onError: () =>
          this.logger.warn(
            `Failed to obtain active allocations, trying again later`,
          ),
      },
    )

    const claimableAllocations = join({
      currentEpoch,
      channelDisputeEpochs,
    }).tryMap(
      ({ currentEpoch, channelDisputeEpochs }) =>
        this.network.claimableAllocations(
          currentEpoch.toNumber() - channelDisputeEpochs,
        ),
      {
        onError: () =>
          this.logger.warn(
            `Failed to obtain claimable allocations, trying again later`,
          ),
      },
    )
    this.logger.info(`Waiting for network data before reconciling every 120s`)

    const disputableAllocations = join({
      currentEpoch,
      activeDeployments,
    }).tryMap(
      ({ currentEpoch, activeDeployments }) =>
        this.network.disputableAllocations(currentEpoch, activeDeployments, 0),
      {
        onError: () =>
          this.logger.warn(
            `Failed to fetch disputable allocations, trying again later`,
          ),
      },
    )

    const costModels = join({
      ticker: timer(600_000),
      targetAllocations,
    }).tryMap(
      async () => {
        return await this.indexer.costModels()
      },
      {
        onError: error =>
          this.logger.warn(`Failed to obtain cost models, trying again later`, {
            error,
          }),
      },
    )

    join({
      ticker: timer(240_000),
      paused: this.network.transactionManager.paused,
      isOperator: this.network.transactionManager.isOperator,
      currentEpoch,
      currentEpochStartBlock,
      maxAllocationEpochs,
      indexingRules,
      activeDeployments,
      targetDeployments,
      activeAllocations,
      targetAllocations,
      recentlyClosedAllocations,
      claimableAllocations,
      disputableAllocations,
      costModels,
    }).pipe(
      async ({
        paused,
        isOperator,
        currentEpoch,
        currentEpochStartBlock,
        maxAllocationEpochs,
        indexingRules,
        activeDeployments,
        targetDeployments,
        activeAllocations,
        targetAllocations,
        recentlyClosedAllocations,
        claimableAllocations,
        disputableAllocations,
        costModels,
      }) => {
        this.logger.info(`Reconcile with the network`)

        // Do nothing else if the network is paused
        if (paused) {
          return this.logger.info(
            `The network is currently paused, not doing anything until it resumes`,
          )
        }

        // Do nothing if we're not authorized as an operator for the indexer
        if (!isOperator) {
          return this.logger.error(
            `Not authorized as an operator for the indexer`,
            {
              err: indexerError(IndexerErrorCode.IE034),
              indexer: toAddress(this.network.indexerAddress),
              operator: toAddress(
                this.network.transactionManager.wallet.address,
              ),
            },
          )
        }

        // Do nothing if there are already approved actions in the queue awaiting execution
        const approvedActions = await this.fetchActions({
          status: ActionStatus.APPROVED,
        })
        if (approvedActions.length > 0) {
          return this.logger.info(
            `There are ${approvedActions.length} approved actions awaiting execution, will reconcile with the network once they are executed`,
          )
        }

        // Claim rebate pool rewards from finalized allocations
        try {
          await this.claimRebateRewards(claimableAllocations)
        } catch (err) {
          this.logger.warn(`Failed to claim rebate rewards`, { err })
        }

        try {
          const disputableEpoch =
            currentEpoch.toNumber() -
            this.network.indexerConfigs.poiDisputableEpochs
          // Find disputable allocations
          await this.identifyPotentialDisputes(
            disputableAllocations,
            disputableEpoch,
          )
        } catch (err) {
          this.logger.warn(`Failed POI dispute monitoring`, { err })
        }
        await this.reconcileCostModel(costModels, targetAllocations)
        try {
          await this.reconcileDeployments(
            activeDeployments,
            targetDeployments,
            [...recentlyClosedAllocations, ...activeAllocations],
          )

          // Reconcile allocations
          await this.reconcileAllocations(
            activeAllocations,
            targetAllocations,
            indexingRules,
            currentEpoch.toNumber(),
            currentEpochStartBlock,
            maxAllocationEpochs,
          )
        } catch (err) {
          this.logger.warn(`Failed to reconcile indexer and network`, {
            err: indexerError(IndexerErrorCode.IE005, err),
          })
        }
      },
    )

    return this
  }

  async claimRebateRewards(allocations: Allocation[]): Promise<void> {
    if (allocations.length > 0) {
      this.logger.info(`Claim rebate rewards`, {
        claimable: allocations.map(allocation => ({
          id: allocation.id,
          deployment: allocation.subgraphDeployment.id.display,
          createdAtEpoch: allocation.createdAtEpoch,
          amount: allocation.queryFeeRebates,
        })),
      })
      await this.network.claimMany(allocations)
    }
  }

  async identifyPotentialDisputes(
    disputableAllocations: Allocation[],
    disputableEpoch: number,
  ): Promise<void> {
    // TODO: Support supplying status = 'any' to fetchPOIDisputes() to fetch all previously processed allocations in a single query
    const alreadyProcessed = (
      await this.indexer.fetchPOIDisputes('potential', disputableEpoch)
    ).concat(await this.indexer.fetchPOIDisputes('valid', disputableEpoch))

    const newDisputableAllocations = disputableAllocations.filter(
      allocation =>
        !alreadyProcessed.find(
          dispute => dispute.allocationID == allocation.id,
        ),
    )
    if (newDisputableAllocations.length == 0) {
      this.logger.trace(
        'No new disputable allocations to process for potential disputes',
      )
      return
    }

    this.logger.debug(
      `Found new allocations onchain for subgraphs we have indexed. Let's compare POIs to identify any potential indexing disputes`,
    )

    const uniqueRewardsPools: RewardsPool[] = await Promise.all(
      [
        ...new Set(
          newDisputableAllocations.map(allocation =>
            allocationRewardsPool(allocation),
          ),
        ),
      ]
        .filter(pool => pool.closedAtEpochStartBlockHash)
        .map(async pool => {
          const closedAtEpochStartBlock = await this.network.ethereum.getBlock(
            pool.closedAtEpochStartBlockHash!,
          )

          // Todo: Lazily fetch this, only if the first reference POI doesn't match
          const previousEpochStartBlock = await this.network.ethereum.getBlock(
            pool.previousEpochStartBlockHash!,
          )
          pool.closedAtEpochStartBlockNumber = closedAtEpochStartBlock.number
          pool.referencePOI = await this.indexer.statusResolver.proofOfIndexing(
            pool.subgraphDeployment,
            {
              number: closedAtEpochStartBlock.number,
              hash: closedAtEpochStartBlock.hash,
            },
            pool.allocationIndexer,
          )
          pool.previousEpochStartBlockHash = previousEpochStartBlock.hash
          pool.previousEpochStartBlockNumber = previousEpochStartBlock.number
          pool.referencePreviousPOI =
            await this.indexer.statusResolver.proofOfIndexing(
              pool.subgraphDeployment,
              {
                number: previousEpochStartBlock.number,
                hash: previousEpochStartBlock.hash,
              },
              pool.allocationIndexer,
            )
          return pool
        }),
    )

    const disputes: POIDisputeAttributes[] = newDisputableAllocations.map(
      (allocation: Allocation) => {
        const rewardsPool = uniqueRewardsPools.find(
          pool =>
            pool.subgraphDeployment == allocation.subgraphDeployment.id &&
            pool.closedAtEpoch == allocation.closedAtEpoch,
        )
        if (!rewardsPool) {
          throw Error(
            `No rewards pool found for deployment ${allocation.subgraphDeployment.id}`,
          )
        }

        let status =
          rewardsPool!.referencePOI == allocation.poi ||
          rewardsPool!.referencePreviousPOI == allocation.poi
            ? 'valid'
            : 'potential'

        if (
          status === 'potential' &&
          (!rewardsPool.referencePOI || !rewardsPool.referencePreviousPOI)
        ) {
          status = 'reference_unavailable'
        }

        return {
          allocationID: allocation.id,
          subgraphDeploymentID: allocation.subgraphDeployment.id.ipfsHash,
          allocationIndexer: allocation.indexer,
          allocationAmount: allocation.allocatedTokens.toString(),
          allocationProof: allocation.poi!,
          closedEpoch: allocation.closedAtEpoch,
          closedEpochReferenceProof: rewardsPool!.referencePOI,
          closedEpochStartBlockHash: allocation.closedAtEpochStartBlockHash!,
          closedEpochStartBlockNumber:
            rewardsPool!.closedAtEpochStartBlockNumber!,
          previousEpochReferenceProof: rewardsPool!.referencePreviousPOI,
          previousEpochStartBlockHash:
            rewardsPool!.previousEpochStartBlockHash!,
          previousEpochStartBlockNumber:
            rewardsPool!.previousEpochStartBlockNumber!,
          status,
        } as POIDisputeAttributes
      },
    )

    const potentialDisputes = disputes.filter(
      dispute => dispute.status == 'potential',
    ).length
    const stored = await this.indexer.storePoiDisputes(disputes)

    this.logger.info(`Disputable allocations' POIs validated`, {
      potentialDisputes: potentialDisputes,
      validAllocations: stored.length - potentialDisputes,
    })
  }

  async reconcileCostModel(
    costModels: CostModelAttributes[],
    targetAllocations: SubgraphDeploymentID[],
  ): Promise<void> {
    const costModelsIDs = costModels
      .filter(model => model.deployment != COST_MODEL_GLOBAL)
      .map(model => new SubgraphDeploymentID(model.deployment))
    const deploymentMissingModels = targetAllocations.filter(
      allocation => !(allocation.bytes32 in costModelsIDs),
    )

    if (deploymentMissingModels) {
      this.logger.warn(
        `The following deployments do not have defined cost models and will use the global cost model if it exists`,
        {
          deployments: deploymentMissingModels,
        },
      )
    }
  }

  async reconcileDeployments(
    activeDeployments: SubgraphDeploymentID[],
    targetDeployments: SubgraphDeploymentID[],
    eligibleAllocations: Allocation[],
  ): Promise<void> {
    activeDeployments = uniqueDeployments(activeDeployments)
    targetDeployments = uniqueDeployments(targetDeployments)
    // Note eligibleAllocations are active or recently closed allocations still eligible for queries from the gateway
    const eligibleAllocationDeployments = uniqueDeployments(
      eligibleAllocations.map(allocation => allocation.subgraphDeployment.id),
    )

    // Ensure the network subgraph deployment is _always_ indexed
    if (this.networkSubgraph.deployment) {
      if (
        !deploymentInList(targetDeployments, this.networkSubgraph.deployment.id)
      ) {
        targetDeployments.push(this.networkSubgraph.deployment.id)
      }
    }

    // Ensure all subgraphs in offchain subgraphs list are _always_ indexed
    for (const offchainSubgraph of this.offchainSubgraphs) {
      if (!deploymentInList(targetDeployments, offchainSubgraph)) {
        targetDeployments.push(offchainSubgraph)
      }
    }

    // only show Reconcile when active ids != target ids
    // TODO: Fix this check, always returning true
    if (
      deploymentIDSet(activeDeployments) != deploymentIDSet(targetDeployments)
    ) {
      // Turning to trace until the above conditional is fixed
      this.logger.trace('Reconcile deployments', {
        syncing: activeDeployments.map(id => id.display),
        target: targetDeployments.map(id => id.display),
        withActiveOrRecentlyClosedAllocation: eligibleAllocationDeployments.map(
          id => id.display,
        ),
      })
    }

    // Identify which subgraphs to deploy and which to remove
    const deploy = targetDeployments.filter(
      deployment => !deploymentInList(activeDeployments, deployment),
    )
    const remove = activeDeployments.filter(
      deployment =>
        !deploymentInList(targetDeployments, deployment) &&
        !deploymentInList(eligibleAllocationDeployments, deployment),
    )

    if (deploy.length + remove.length !== 0) {
      this.logger.info('Deployment changes', {
        deploy: deploy.map(id => id.display),
        remove: remove.map(id => id.display),
      })
    }

    // Deploy/remove up to 10 subgraphs in parallel
    const queue = new PQueue({ concurrency: 10 })

    // Index all new deployments worth indexing
    await queue.addAll(
      deploy.map(deployment => async () => {
        const name = `indexer-agent/${deployment.ipfsHash.slice(-10)}`

        this.logger.info(`Index subgraph deployment`, {
          name,
          deployment: deployment.display,
        })

        // Ensure the deployment is deployed to the indexer
        // Note: we're not waiting here, as sometimes indexing a subgraph
        // will block if the IPFS files cannot be retrieved
        this.indexer.ensure(name, deployment)
      }),
    )

    // Stop indexing deployments that are no longer worth indexing
    await queue.addAll(
      remove.map(deployment => async () => this.indexer.remove(deployment)),
    )

    await queue.onIdle()
  }

  async reconcileAllocations(
    activeAllocations: Allocation[],
    targetAllocations: SubgraphDeploymentID[],
    rules: IndexingRuleAttributes[],
    currentEpoch: number,
    currentEpochStartBlock: BlockPointer,
    maxAllocationEpochs: number,
  ): Promise<void> {
    if (this.allocationManagementMode == AllocationManagementMode.MANUAL) {
      this.logger.trace(
        `Skipping allocation reconciliation since AllocationManagementMode = 'manual'`,
        {
          activeAllocations,
          targetAllocations,
        },
      )
      return
    }

    this.logger.trace(`Reconcile allocations`, {
      currentEpoch,
      maxAllocationEpochs,
      targetAllocations: targetAllocations.map(
        deployment => deployment.ipfsHash,
      ),
      activeAllocations: activeAllocations.map(allocation => ({
        id: allocation.id,
        deployment: allocation.subgraphDeployment.id.ipfsHash,
        createdAtEpoch: allocation.createdAtEpoch,
      })),
    })

    // Calculate the union of active deployments and target deployments
    const deployments = uniqueDeployments([
      ...targetAllocations,
      ...activeAllocations.map(allocation => allocation.subgraphDeployment.id),
    ])

    // Ensure the network subgraph is never allocated towards
    if (
      !this.allocateOnNetworkSubgraph &&
      this.networkSubgraph.deployment?.id.bytes32
    ) {
      const networkSubgraphDeploymentId = this.networkSubgraph.deployment.id
      targetAllocations = targetAllocations.filter(
        deployment =>
          deployment.bytes32 !== networkSubgraphDeploymentId.bytes32,
      )
    }

    this.logger.debug(`Deployments to reconcile allocations for`, {
      number: deployments.length,
      deployments: deployments.map(deployment => deployment.ipfsHash),
    })

    await pMap(
      deployments,
      async deployment => {
        await this.reconcileDeploymentAllocations(
          deployment,

          // Active allocations for the subgraph deployment
          activeAllocations.filter(
            allocation =>
              allocation.subgraphDeployment.id.bytes32 === deployment.bytes32,
          ),

          // Whether the deployment is worth allocating towards
          deploymentInList(targetAllocations, deployment),

          // Indexing rule for the deployment (if any)
          rules.find(
            rule =>
              rule.identifierType === SubgraphIdentifierType.DEPLOYMENT &&
              new SubgraphDeploymentID(rule.identifier).toString() ===
                deployment.toString(),
          ) || rules.find(rule => rule.identifier === INDEXING_RULE_GLOBAL),

          currentEpoch,
          currentEpochStartBlock,
          maxAllocationEpochs,
        )
      },
      { concurrency: 1 },
    )
  }

  // TODO: Skip evaluation or short-circuit if item already in queue or AllocationManagementMode = MANUAL
  async reconcileDeploymentAllocations(
    deployment: SubgraphDeploymentID,
    activeAllocations: Allocation[],
    worthAllocating: boolean,
    rule: IndexingRuleAttributes | undefined,
    epoch: number,
    epochStartBlock: BlockPointer,
    maxAllocationEpochs: number,
  ): Promise<void> {
    const logger = this.logger.child({
      deployment: deployment.ipfsHash,
      epoch,
    })

    const desiredAllocationAmount = rule?.allocationAmount
      ? BigNumber.from(rule.allocationAmount)
      : this.indexer.defaultAllocationAmount
    const desiredNumberOfAllocations = 1
    const desiredAllocationLifetime = rule?.allocationLifetime
      ? rule.allocationLifetime
      : Math.max(1, maxAllocationEpochs - 1)
    const activeAllocationAmount = activeAllocations.reduce(
      (sum, allocation) => sum.add(allocation.allocatedTokens),
      BigNumber.from('0'),
    )

    logger.debug(
      `Reconcile deployment allocations for deployment '${deployment.ipfsHash}'`,
      {
        desiredAllocationAmount: formatGRT(desiredAllocationAmount),
        desiredAllocationLifetime,

        totalActiveAllocationAmount: formatGRT(activeAllocationAmount),

        desiredNumberOfAllocations,
        activeNumberOfAllocations: activeAllocations.length,

        activeAllocations: activeAllocations.map(allocation => ({
          id: allocation.id,
          createdAtEpoch: allocation.createdAtEpoch,
          amount: formatGRT(allocation.allocatedTokens),
        })),
      },
    )

    // Return early if the deployment is not (or no longer) worth allocating towards
    if (!worthAllocating) {
      logger.info(
        `Deployment is not (or no longer) worth allocating towards, close allocation if it is from a previous epoch`,
        {
          eligibleForClose: activeAllocations
            .filter(allocation => allocation.createdAtEpoch < epoch)
            .map(allocation => allocation.id),
        },
      )

      // Make sure to close all active allocations on the way out
      if (activeAllocations.length > 0) {
        await pMap(
          // We can only close allocations from a previous epoch;
          // try the others again later
          activeAllocations.filter(
            allocation => allocation.createdAtEpoch < epoch,
          ),
          async allocation => {
            // Send UnallocateAction to the queue
            await this.queueAction({
              params: {
                allocationID: allocation.id,
                deploymentID: deployment.ipfsHash,
                poi: undefined,
                force: false,
              },
              type: ActionType.UNALLOCATE,
            } as ActionItem)
          },
          { concurrency: 1 },
        )
      }
      return
    }

    // If there are no allocations at all yet, create a new allocation
    if (activeAllocations.length === 0) {
      logger.info(`No active allocation for deployment, creating one now`, {
        allocationAmount: formatGRT(desiredAllocationAmount),
      })

      // Skip allocating if the previous allocation for this deployment was closed with a null or 0x00 POI
      const closedAllocation = (
        await this.networkMonitor.closedAllocations(deployment)
      )[0]
      if (
        closedAllocation &&
        closedAllocation.poi === utils.hexlify(Array(32).fill(0))
      ) {
        logger.warn(
          `Skipping allocation to this deployment as the last allocation to it was closed with a zero POI`,
          {
            deployment,
            closedAllocation: closedAllocation.id,
          },
        )
        return
      }

      // Send AllocateAction to the queue
      await this.queueAction({
        params: {
          deploymentID: deployment.ipfsHash,
          amount: formatGRT(desiredAllocationAmount),
        },
        type: ActionType.ALLOCATE,
      })

      return
    }

    // Remove any parallel allocations (deprecated)
    const allocationsToRemove =
      activeAllocations.length - desiredNumberOfAllocations
    if (allocationsToRemove > 0) {
      logger.info(
        `Close allocations to maintain desired number of allocations`,
        {
          desiredNumberOfAllocations,
          activeAllocations: activeAllocations.length,
          allocationsToRemove: allocationsToRemove,
          allocationAmount: formatGRT(desiredAllocationAmount),
        },
      )
      await pMap(
        // We can only close allocations that are at least one epoch old; try the others again later
        // Close the oldest allocations first
        activeAllocations
          .filter(allocation => allocation.createdAtEpoch < epoch)
          .sort((a, b) => a.createdAtEpoch - b.closedAtEpoch)
          .splice(0, allocationsToRemove),
        async allocation => {
          // Send UnallocateAction to the queue
          await this.queueAction({
            params: {
              allocationID: allocation.id,
              poi: undefined,
              force: false,
            },
            type: ActionType.UNALLOCATE,
          })
        },
        { concurrency: 1 },
      )
    }

    // For allocations that have expired, let's reallocate in one transaction (closeAndAllocate)
    let expiredAllocations = activeAllocations.filter(
      allocation =>
        epoch >= allocation.createdAtEpoch + desiredAllocationLifetime,
    )
    // The allocations come from the network subgraph; due to short indexing
    // latencies, this data may be slightly outdated. Cross-check with the
    // contracts to avoid closing allocations that are already closed on
    // chain.
    expiredAllocations = await pFilter(
      expiredAllocations,
      async (allocation: Allocation) => {
        try {
          const onChainAllocation =
            await this.network.contracts.staking.getAllocation(allocation.id)
          return onChainAllocation.closedAtEpoch.eq('0')
        } catch (err) {
          this.logger.warn(
            `Failed to cross-check allocation state with contracts; assuming it needs to be closed`,
            {
              deployment: deployment.display,
              allocation: allocation.id,
              err: indexerError(IndexerErrorCode.IE006, err),
            },
          )
          return true
        }
      },
    )

    if (expiredAllocations.length > 0) {
      if (rule?.autoRenewal) {
        logger.info(`Reallocating expired allocations`, {
          number: expiredAllocations.length,
          expiredAllocations: expiredAllocations.map(
            allocation => allocation.id,
          ),
        })

        // Queue reallocate actions to be picked up by the worker
        await pMap(expiredAllocations, async allocation => {
          await this.queueAction({
            params: {
              allocationID: allocation.id,
              deploymentID: deployment.ipfsHash,
              amount: formatGRT(desiredAllocationAmount),
            },
            type: ActionType.REALLOCATE,
          })
        })
      } else {
        logger.info(
          `Skipping reallocating of expired allocations since the corresponding rule has 'autoRenewal' = False`,
          {
            number: expiredAllocations.length,
            expiredAllocations: expiredAllocations.map(
              allocation => allocation.id,
            ),
          },
        )
      }
    }
  }

  private async fetchActions(
    actionFilter: ActionFilter,
  ): Promise<ActionResult[]> {
    const result = await this.indexer.indexerManagement
      .query(
        gql`
          query actions($filter: ActionFilter!) {
            actions(filter: $filter) {
              id
              type
              allocationID
              deploymentID
              amount
              poi
              force
              source
              reason
              priority
              transaction
              status
              failureReason
            }
          }
        `,
        { filter: actionFilter },
      )
      .toPromise()

    if (result.error) {
      throw result.error
    }

    return result.data.actions
  }

  private async queueAction(action: ActionItem): Promise<Action[]> {
    let status = ActionStatus.QUEUED
    switch (this.allocationManagementMode) {
      case AllocationManagementMode.MANUAL:
        throw Error(
          `Cannot queue actions when AllocationManagementMode = 'MANUAL'`,
        )
      case AllocationManagementMode.AUTO:
        status = ActionStatus.APPROVED
        break
      case AllocationManagementMode.OVERSIGHT:
        status = ActionStatus.QUEUED
    }

    const actionInput = {
      ...action.params,
      status,
      type: action.type,
      source: 'indexerAgent',
      reason: 'indexingRule',
      priority: 0,
    } as ActionInput

    const actionResult = await this.indexer.indexerManagement
      .mutation(
        gql`
          mutation queueActions($actions: [ActionInput!]!) {
            queueActions(actions: $actions) {
              id
              type
              deploymentID
              source
              reason
              priority
              status
            }
          }
        `,
        { actions: [actionInput] },
      )
      .toPromise()

    if (actionResult.error) {
      if (
        actionResult.error instanceof CombinedError &&
        actionResult.error.message.includes('Duplicate')
      ) {
        this.logger.warn(
          `Action not queued: Already a queued action targeting ${actionInput.deploymentID} from another source`,
          { action },
        )
        return []
      }
      throw actionResult.error
    }

    if (actionResult.data.queueActions.length > 0) {
      this.logger.info(`Queued ${action.type} action for execution`, {
        queuedAction: actionResult.data.queueActions,
      })
    }

    return actionResult.data.queueActions
  }
}

export const startAgent = async (config: AgentConfig): Promise<Agent> => {
  const agent = new Agent(
    config.logger,
    config.metrics,
    config.indexer,
    config.network,
    config.networkMonitor,
    config.networkSubgraph,
    config.allocateOnNetworkSubgraph,
    config.registerIndexer,
    config.offchainSubgraphs,
    config.receiptCollector,
    config.allocationManagementMode,
  )
  return await agent.start()
}
